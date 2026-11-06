import Foundation
import CryptoKit
@preconcurrency import AVFoundation

enum VideoArchive {
    static func path(_ id:String,_ index:Int)->String { "videos/\(id)/\(index).part" }
    static func validHash(_ text:String?) -> Bool { guard let text else{return false};return text.count==64 && text.utf8.allSatisfy{(48...57).contains($0)||(97...102).contains($0)} }
    static func validate(_ record:JSON) throws {
        guard let id=record["id"].string,SegmentedVideoCrypto.validID(id),record["videoVersion"].integer==2,record["mime"].string=="video/mp4",record["path"].string=="photos/\(id).mp4",let size=record["size"].integer,size>0,size<=SegmentedVideoCrypto.maximumBytes,case .number(let duration)=record["duration"],duration.isFinite,duration>0,duration<=600,let width=record["width"].integer,let height=record["height"].integer,min(width,height)>0,max(width,height)<=1920,min(width,height)<=1080,record["segments"].array.count==(size+SegmentedVideoCrypto.chunkBytes-1)/SegmentedVideoCrypto.chunkBytes,validHash(record["sha256"].string) else { throw VideoV2Error.invalidManifest }
        for(index,segment)in record["segments"].array.enumerated() { guard segment["id"].string==id,segment["index"].integer==index,segment["path"].string==path(id,index),segment["size"].integer==min(SegmentedVideoCrypto.chunkBytes,size-index*SegmentedVideoCrypto.chunkBytes),validHash(segment["sha256"].string) else { throw VideoV2Error.invalidManifest } }
    }
    static func validateSegment(_ segment:JSON,files:[String:Data]) throws {
        guard let id=segment["id"].string,SegmentedVideoCrypto.validID(id),let index=segment["index"].integer,(0..<63).contains(index),segment["path"].string==path(id,index),let bytes=files[path(id,index)],bytes.count==segment["size"].integer,bytes.count>0,bytes.count<=SegmentedVideoCrypto.chunkBytes,SegmentedVideoCrypto.hash(bytes)==segment["sha256"].string else { throw VideoV2Error.integrity }
    }
    @MainActor static func assemble(_ record:JSON,read:(JSON)throws->Data) async throws -> PreparedPhoto {
        try validate(record)
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent("porchday-video-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);defer{try? FileManager.default.removeItem(at:folder)}
        let url=folder.appendingPathComponent("video.mp4");FileManager.default.createFile(atPath:url.path,contents:nil,attributes:[.posixPermissions:0o600])
        let handle=try FileHandle(forWritingTo:url);defer{try? handle.close()};var hash=SHA256()
        for segment in record["segments"].array {try Task.checkCancellation();let bytes=try read(segment);try validateSegment(segment,files:[segment["path"].string!:bytes]);hash.update(data:bytes);try handle.write(contentsOf:bytes);await Task.yield()}
        guard hash.finalize().map({String(format:"%02x",$0)}).joined()==record["sha256"].string else{throw VideoV2Error.integrity};try handle.synchronize()
        let selected=try SelectedVideoFile(copying:url),asset=AVURLAsset(url:selected.url)
        let duration=try await LargeVideoPreparation.inspect(selected),videos=try await asset.loadTracks(withMediaType:.video),audios=try await asset.loadTracks(withMediaType:.audio)
        guard duration<=600.1 else{throw VideoV2Error.invalidManifest}
        for track in videos {let formats=try await track.load(.formatDescriptions);guard formats.allSatisfy({CMFormatDescriptionGetMediaSubType($0)==kCMVideoCodecType_H264})else{throw VideoV2Error.invalidManifest}}
        for track in audios {let formats=try await track.load(.formatDescriptions);guard formats.allSatisfy({CMFormatDescriptionGetMediaSubType($0)==kAudioFormatMPEG4AAC})else{throw VideoV2Error.invalidManifest}}
        let width=record["width"].integer!,height=record["height"].integer!
        guard let track=videos.first else{throw VideoV2Error.invalidManifest}
        let natural=try await track.load(.naturalSize),transform=try await track.load(.preferredTransform),display=natural.applying(transform)
        guard Int(abs(display.width).rounded())==width,Int(abs(display.height).rounded())==height else{throw VideoV2Error.invalidManifest}
        let prepared=PreparedLargeNativeVideo(source:selected,url:selected.url,width:width,height:height,duration:min(duration,600))
        return PreparedPhoto(bytes:Data(),width:width,height:height,alt:record["alt"].string ?? "",mime:"video/mp4",poster:record["poster"].string ?? "",caption:record["caption"].string ?? "",tags:PersonTag.parse(record["tags"]),largeVideo:prepared)
    }
}
