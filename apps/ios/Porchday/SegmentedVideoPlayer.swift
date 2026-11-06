import Foundation
@preconcurrency import AVFoundation
import UniformTypeIdentifiers

/// AVPlayer asks for byte ranges; only the required authenticated chunks are
/// downloaded/decrypted. No plaintext file or public playlist is created.
@MainActor final class SegmentedVideoResourceLoader: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    let asset: AVURLAsset
    private let api: API
    private let mediaID: String
    private let manifest: VideoV2Manifest
    private var expiry: Date?
    private var cache: [Int:Data] = [:]
    private var tasks: [ObjectIdentifier:Task<Void,Never>] = [:]
    private var observation: Task<Void,Never>?
    private var stopped = false
    private let ended: @MainActor (String) -> Void
    init(api: API, mediaID: String, manifest: VideoV2Manifest, expiry: Date?, ended: @escaping @MainActor (String) -> Void) throws {
        try SegmentedVideoCrypto.validate(manifest)
        guard SegmentedVideoCrypto.validID(mediaID), expiry.map({ $0 > Date() }) ?? true else { throw VideoV2Error.invalidManifest }
        self.api=api;self.mediaID=mediaID;self.manifest=manifest;self.expiry=expiry;self.ended=ended
        self.asset=AVURLAsset(url:URL(string:"porchday-video://local/"+UUID().uuidString+".mp4")!)
        super.init();asset.resourceLoader.setDelegate(self,queue:.main)
        observation=Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.stopped else { return }
                do {
                    let result=try await self.api.social("/videos/"+self.mediaID+"/access")
                    if let current=result["expiresAt"].string.flatMap(PorchDate.parse) { self.expiry=min(self.expiry ?? current,current) }
                    try self.check();try await Task.sleep(for:.seconds(10))
                } catch { if !Task.isCancelled { self.stop();self.ended("This video is no longer available.") };return }
            }
        }
    }
    private func check() throws { if stopped || Task.isCancelled || !(expiry.map({ $0 > Date() }) ?? true) { throw CancellationError() } }
    func stop() { guard !stopped else { return };stopped=true;observation?.cancel();observation=nil;for task in tasks.values { task.cancel() };tasks.removeAll();cache.removeAll() }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        let identity=ObjectIdentifier(request)
        guard !stopped, tasks.count<4 else { request.finishLoading(with:VideoV2Error.integrity);return true }
        tasks[identity]=Task { [weak self] in
            guard let self else { request.finishLoading(with:CancellationError());return }
            defer { self.tasks.removeValue(forKey:identity) }
            do {
                try self.check()
                if let info=request.contentInformationRequest { info.contentType=UTType.mpeg4Movie.identifier;info.contentLength=Int64(self.manifest.size);info.isByteRangeAccessSupported=true }
                if let range=request.dataRequest {
                    let start=range.currentOffset > 0 ? range.currentOffset : range.requestedOffset
                    guard start>=0, start<=Int64(self.manifest.size), range.requestedLength>=0 else { throw VideoV2Error.integrity }
                    var offset=Int(start)
                    guard range.requestedOffset>=0,start>=range.requestedOffset,range.requestedOffset<=Int64(self.manifest.size) else { throw VideoV2Error.integrity }
                    let requestedEnd=range.requestsAllDataToEndOfResource ? self.manifest.size : Int(range.requestedOffset)+min(range.requestedLength,self.manifest.size-Int(range.requestedOffset))
                    let end=max(offset,requestedEnd)
                    while offset<end {
                        try self.check();let index=offset/SegmentedVideoCrypto.chunkBytes
                        let bytes:Data
                        if let cached=self.cache[index] { bytes=cached }
                        else {
                            let cipher=try await self.api.videoChunk("/api/v1/videos/"+self.mediaID+"/chunks/"+String(index),expectedSize:self.manifest.segments[index].size)
                            try self.check();bytes=try SegmentedVideoCrypto.decrypt(cipher,manifest:self.manifest,index:index)
                            if self.cache.count>=2 { self.cache.removeAll() };self.cache[index]=bytes
                        }
                        let local=offset-index*SegmentedVideoCrypto.chunkBytes,count=min(64*1024,bytes.count-local,end-offset)
                        guard count>0 else { throw VideoV2Error.integrity };try self.check()
                        range.respond(with:bytes.subdata(in:local..<local+count));offset+=count
                    }
                }
                try self.check();request.finishLoading()
            } catch { if !request.isCancelled { request.finishLoading(with:error) } }
        }
        return true
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,didCancel request:AVAssetResourceLoadingRequest) { tasks.removeValue(forKey:ObjectIdentifier(request))?.cancel() }
}
