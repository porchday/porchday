import Foundation
@preconcurrency import AVFoundation
import CoreTransferable
import UniformTypeIdentifiers

/// File-backed selections avoid loading a 1 GiB movie into a PhotosPicker Data.
final class SelectedVideoFile: @unchecked Sendable, Identifiable {
    let id = UUID()
    let url: URL
    let directory: URL
    init(copying source: URL) throws {
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 1_073_741_824 else { throw PorchError.message("Choose a video source up to 1 GiB.") }
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("porchday-video-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        url = directory.appendingPathComponent("source." + source.pathExtension)
        do {
            try FileManager.default.copyItem(at: source, to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            var folder = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try folder.setResourceValues(values)
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}
struct SelectedVideoTransfer: Transferable {
    let file: SelectedVideoFile
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            SelectedVideoTransfer(file: try SelectedVideoFile(copying: received.file))
        }
    }
}
final class PreparedLargeNativeVideo: @unchecked Sendable {
    let source: SelectedVideoFile
    let url: URL
    let width: Int
    let height: Int
    let duration: Double
    init(source: SelectedVideoFile, url: URL, width: Int, height: Int, duration: Double) { self.source=source;self.url=url;self.width=width;self.height=height;self.duration=duration }
    deinit { try? FileManager.default.removeItem(at: url) }
}
private final class VideoExportCancellation: @unchecked Sendable {
    let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session=session }
    func cancel() { session.cancelExport() }
    func run() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void,Error>) in
            session.exportAsynchronously { [self] in
                if session.status == .completed { continuation.resume() }
                else { continuation.resume(throwing: session.error ?? PorchError.message("Video preparation was canceled.")) }
            }
        }
    }
}
@MainActor enum LargeVideoPreparation {
    static func inspect(_ file: SelectedVideoFile) async throws -> Double {
        let asset=AVURLAsset(url:file.url),tracks=try await asset.loadTracks(withMediaType:.video),audio=try await asset.loadTracks(withMediaType:.audio)
        guard tracks.count==1,audio.count<=1,try await asset.load(.isPlayable) else { throw PorchError.message("Choose a playable video with one picture track and at most one audio track.") }
        // Do not silently map HDR colors using a preset with device-dependent behavior.
        guard !(try await tracks[0].load(.mediaCharacteristics)).contains(.containsHDRVideo) else { throw PorchError.message("Export an SDR H.264 copy of this HDR video before sharing so its colors stay correct.") }
        let duration=try await asset.load(.duration).seconds
        guard duration.isFinite,duration>0 else { throw PorchError.message("This video has an invalid duration.") };return duration
    }
    static func prepare(_ source: SelectedVideoFile, resolution:Int, start:Double, end:Double) async throws -> PreparedPhoto {
        let duration=try await inspect(source)
        guard [720,1080].contains(resolution),start.isFinite,end.isFinite,start>=0,end<=duration+0.001,end>start,end-start<=600 else { throw PorchError.message("Choose a section up to 10 minutes within this video.") }
        try Task.checkCancellation()
        let asset=AVURLAsset(url:source.url),destination=source.directory.appendingPathComponent(UUID().uuidString+".mp4")
        guard let export=AVAssetExportSession(asset:asset,presetName:resolution==1080 ? AVAssetExportPreset1920x1080:AVAssetExportPreset1280x720) else { throw PorchError.message("This video cannot be prepared on this device. Export an H.264/AAC MP4 first.") }
        export.outputURL=destination;export.outputFileType = .mp4;export.shouldOptimizeForNetworkUse=true;export.metadata=[]
        export.timeRange=CMTimeRange(start:CMTime(seconds:start,preferredTimescale:600),end:CMTime(seconds:end,preferredTimescale:600))
        export.fileLengthLimit=Int64(SegmentedVideoCrypto.maximumBytes)
        let cancellation=VideoExportCancellation(export)
        do {
            try await withTaskCancellationHandler { try await cancellation.run() } onCancel: { cancellation.cancel() }
            try Task.checkCancellation()
            let size=try destination.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
            guard size>0,size<=SegmentedVideoCrypto.maximumBytes else { throw PorchError.message("Choose 720p or a shorter section to fit within 250 MiB.") }
            let output=AVURLAsset(url:destination),tracks=try await output.loadTracks(withMediaType:.video)
            guard tracks.count==1 else { throw PorchError.message("The prepared video has no picture.") }
            let format=try await tracks[0].load(.formatDescriptions)
            guard format.allSatisfy({ CMFormatDescriptionGetMediaSubType($0)==kCMVideoCodecType_H264 }) else { throw PorchError.message("This device did not produce compatible H.264 video.") }
            let inputAudio=try await asset.loadTracks(withMediaType:.audio),outputAudio=try await output.loadTracks(withMediaType:.audio)
            guard inputAudio.count==outputAudio.count else { throw PorchError.message("Video preparation could not preserve the audio.") }
            for track in outputAudio { let descriptions=try await track.load(.formatDescriptions);guard descriptions.allSatisfy({ CMFormatDescriptionGetMediaSubType($0)==kAudioFormatMPEG4AAC }) else { throw PorchError.message("Video preparation could not produce compatible AAC sound.") } }
            let natural=try await tracks[0].load(.naturalSize),transform=try await tracks[0].load(.preferredTransform),display=natural.applying(transform),width=Int(abs(display.width)),height=Int(abs(display.height))
            guard min(width,height)>0,max(width,height)<=1920,min(width,height)<=1080 else { throw VideoV2Error.invalidManifest }
            let generator=AVAssetImageGenerator(asset:output);generator.appliesPreferredTrackTransform=true;generator.maximumSize=CGSize(width:320,height:320)
            let(frame,_)=try await generator.image(at:.zero),poster=try AppleImageEncoder.encode(AppleImageEncoder.opaque(frame),jpeg:true)
            let prepared=PreparedLargeNativeVideo(source:source,url:destination,width:width,height:height,duration:end-start)
            return PreparedPhoto(bytes:Data(),width:width,height:height,mime:"video/mp4",poster:poster.base64EncodedString(),largeVideo:prepared)
        } catch { try? FileManager.default.removeItem(at:destination);throw error }
    }
}
