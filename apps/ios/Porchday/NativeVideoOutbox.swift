import Foundation

/// Only encrypted chunks, signed encrypted envelopes and public routing are
/// durable. Preparation files and unwrapped video keys are never saved here.
@MainActor final class NativeVideoOutbox {
    struct Pending: Identifiable { let id:String;let createdAt:String }
    let owner:String
    let directory:URL
    init(owner:String) throws {
        guard SegmentedVideoCrypto.validID(owner) else { throw VideoV2Error.invalidManifest };self.owner=owner
        directory=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).appendingPathComponent("EncryptedVideoOutbox",isDirectory:true).appendingPathComponent(owner,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        var folder=directory;var values=URLResourceValues();values.isExcludedFromBackup=true;try folder.setResourceValues(values)
    }
    private func folder(_ id:String) throws -> URL {
        guard SegmentedVideoCrypto.validID(id) else { throw VideoV2Error.invalidManifest }
        let url=directory.appendingPathComponent(id,isDirectory:true);try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);return url
    }
    private func write(_ bytes:Data,to url:URL) throws { try bytes.write(to:url,options:SecureTemporaryFiles.writeOptions);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path) }
    func discard(_ id:String) throws { try FileManager.default.removeItem(at:folder(id)) }
    func pending() throws -> [Pending] {
        try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil).compactMap { url in
            guard let value=try? read(url.lastPathComponent) else { return nil };return Pending(id:url.lastPathComponent,createdAt:value["createdAt"].string ?? "")
        }.sorted { $0.createdAt<$1.createdAt }
    }
    private func read(_ id:String) throws -> JSON {
        let data=try Data(contentsOf:folder(id).appendingPathComponent("publication.json"));guard data.count<=25*1024*1024 else { throw VideoV2Error.integrity }
        let value=try JSONDecoder().decode(JSON.self,from:data)
        guard value["owner"].string==owner,value["id"].string==id,value["post"]["envelope"]["context"]["id"].string==id,value["media"].array.count<=10 else { throw VideoV2Error.integrity };return value
    }
    func stage(_ photo:PreparedPhoto,postID:String,model:AppModel,audience:String,group:String?,expiry:Date?,storageID:String?=nil) async throws -> (metadata:JSON,reservation:JSON) {
        guard let member=model.member,member.id==owner else { throw CancellationError() }
        let id=UUID().uuidString.lowercased(),folder=try folder(storageID ?? postID)
        var metadata:JSON = .object(["id":.string(id),"mime":.string(photo.mime),"name":.string(photo.largeVideo == nil ? "photo.jpg":"video.mp4"),"alt":.string(photo.alt),"caption":.string(photo.caption),"tags":.array(photo.tags.map(\.json)),"poster":.string(photo.poster),"posterExpiresAt":expiry.map{.string(PorchDate.string($0))} ?? .null,"width":.number(Double(photo.width)),"height":.number(Double(photo.height))])
        var payload:JSON,stream:VideoV2Manifest?
        if let video=photo.largeVideo {
            let size=try video.url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
            var manifest=VideoV2Manifest(v:2,protocol:"porchday-video-aes256gcm-v2",streamId:UUID().uuidString.lowercased(),key:SegmentedVideoCrypto.newKey(),mime:"video/mp4",size:size,duration:video.duration,width:video.width,height:video.height,chunkSize:SegmentedVideoCrypto.chunkBytes,segments:[])
            let handle=try FileHandle(forReadingFrom:video.url);defer{try? handle.close()}
            var index=0
            while let bytes=try handle.read(upToCount:SegmentedVideoCrypto.chunkBytes),!bytes.isEmpty {
                try Task.checkCancellation();let(ciphertext,segment)=try SegmentedVideoCrypto.encrypt(bytes,key:manifest.key,stream:manifest.streamId,index:index)
                try write(ciphertext,to:folder.appendingPathComponent("\(id)-\(index)"));manifest.segments.append(segment);index+=1
                await Task.yield()
            }
            try SegmentedVideoCrypto.validate(manifest);stream=manifest
            metadata=metadata.replacing("videoVersion",with:.number(2)).replacing("duration",with:.number(video.duration))
            guard let fallback=Bundle.main.url(forResource:"video-update-required",withExtension:"mp4") else { throw PorchError.message("The legacy video compatibility asset is missing from this build.") }
            payload=metadata.replacing("video",with:try JSONDecoder().decode(JSON.self,from:JSONEncoder().encode(manifest))).replacing("bytes",with:.string(try Data(contentsOf:fallback).base64EncodedString()))
        } else { payload=metadata.replacing("bytes",with:.string(photo.bytes.base64EncodedString())) }
        let envelope=try await model.vault.seal(payload,member:member,kind:"media",audience:audience,id:id,group:group,parent:postID,expiry:expiry),bytes=try JSONEncoder().encode(envelope)
        guard bytes.count<=(stream == nil ? 22_020_096:1_048_576) else {throw PorchError.message("This encrypted attachment is too large for this audience. Choose a smaller audience or attachment.")}
        try write(bytes,to:folder.appendingPathComponent(id))
        var reservation:JSON = .object(["id":.string(id),"byte_size":.number(Double(bytes.count))])
        if let stream { reservation=reservation.replacing("stream_id",with:.string(stream.streamId)).replacing("segments",with:.array(stream.segments.map{ .object(["index":.number(Double($0.index)),"size":.number(Double($0.size)),"sha256":.string($0.sha256)]) })) }
        return(metadata,reservation)
    }
    func save(_ id:String,media:[JSON],post:JSON) throws {
        let publication:JSON = .object(["version":.number(1),"owner":.string(owner),"id":.string(id),"createdAt":.string(PorchDate.string(Date())),"media":.array(media),"post":post])
        try write(JSONEncoder().encode(publication),to:folder(id).appendingPathComponent("publication.json"))
    }
    func send(_ id:String,api:API,check:() throws -> Void,progress:(String)->Void) async throws {
        let publication=try read(id)
        do { let existing=try await api.social("/posts/"+id);guard existing["post"]["envelope"]==publication["post"]["envelope"] else { throw PorchError.message("This saved post differs from the published version. Cancel the local upload and review your feed.") };try discard(id);return }
        catch PorchError.api(let code,_,_) where code=="NOT_FOUND" { }
        for media in publication["media"].array { try await sendStaged(id,media:media,api:api,check:check,progress:progress) }
        try check();progress("Sharing post…");_ = try await api.social("/posts",method:"POST",body:publication["post"]);try discard(id)
    }
    func sendStaged(_ id:String,media:JSON,api:API,check:() throws -> Void,progress:(String)->Void) async throws {
        let folder=try folder(id)
            try check();try Task.checkCancellation();let mediaID=media["id"].string!,video=media["stream_id"].string != nil
            progress("Resuming encrypted upload…")
            let envelopeFile=folder.appendingPathComponent(mediaID)
            let size=try envelopeFile.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
            guard size==media["byte_size"].integer,size<=22_020_096 else { throw VideoV2Error.integrity }
            let envelope=try JSONDecoder().decode(JSON.self,from:Data(contentsOf:envelopeFile))
            let reservation=try await api.social(video ? "/videos":"/media",method:"POST",body:media.replacing("envelope",with:envelope))
            if video {
                let state=try await api.social("/videos/\(mediaID)/status"),received=Set(state["received"].array.compactMap(\.integer))
                for segment in media["segments"].array {
                    guard let index=segment["index"].integer,let expected=segment["size"].integer else { throw VideoV2Error.integrity }
                    if received.contains(index) { continue };try check();try Task.checkCancellation();progress("Uploading video segment \(index+1) of \(media["segments"].array.count)…")
                    let file=folder.appendingPathComponent("\(mediaID)-\(index)")
                    guard try file.resourceValues(forKeys:[.fileSizeKey]).fileSize==expected else { throw VideoV2Error.integrity }
                    let data=try Data(contentsOf:file);_ = try await api.bytes("/api/v1/videos/\(mediaID)/chunks/\(index)",method:"PUT",body:data)
                }
                _ = try await api.social("/videos/\(mediaID)/complete",method:"POST",body:.object([:]))
            }
            if !["ready","attached"].contains(reservation["state"].string ?? "") {
                try check();guard let path=reservation["upload_url"].string else { throw VideoV2Error.integrity }
                _ = try await api.bytes(path,method:"PUT",body:Data(contentsOf:folder.appendingPathComponent(mediaID)))
            }

    }
    func cancel(_ id:String,api:API) async throws {
        let publication=try read(id)
        do { _ = try await api.social("/posts/"+id);try discard(id);return }
        catch PorchError.api(let code,_,_) where code=="NOT_FOUND" { }
        for media in publication["media"].array where media["stream_id"].string != nil { _ = try await api.social("/videos/"+media["id"].string!,method:"DELETE") }
        try discard(id)
    }
}
