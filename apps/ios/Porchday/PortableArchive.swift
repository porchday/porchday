import Foundation
import CryptoKit
import ZIPFoundation

struct PortableArchive {
    let manifest: JSON
    let files: [String: Data]
    static let limit = 30 * 1024 * 1024
    static let partBudget = 20 * 1024 * 1024
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func zip() throws -> Data {
        let archive = try Archive(accessMode: .create)
        var entries = files
        entries["archive.json"] = try JSONEncoder().encode(manifest)
        let texts = (manifest["posts"].array + manifest["comments"].array).map { "<article><p>" + Self.escape($0["payload"]["text"].string ?? "") + "</p><small>" + Self.escape($0["created_at"].string ?? "") + "</small></article>" }.joined()
        entries["index.html"] = Data(("<!doctype html><meta charset=utf-8><title>Your Porchday archive</title><h1>Your Porchday archive</h1><p>This is one part of a member-owned archive. Keep every part. Saved copies are outside service deletion control.</p>" + texts + "<p>Full structured data is in archive.json. Photos may be in another archive part.</p>").utf8)
        if let index = manifest["archive_set"]["index"].integer {
            let suffix=String(format:"%03d",index)
            entries["archive-part-\(suffix).json"]=entries["archive.json"]
            entries["index-part-\(suffix).html"]=entries.removeValue(forKey:"index.html")
            if manifest["archive_set"]["complete"].boolean {
                let total=manifest["archive_set"]["total"].integer ?? index
                let links=(1...total).map { "<li><a href=\"index-part-" + String(format:"%03d",$0) + ".html\">Part \($0)</a></li>" }.joined()
                entries["index.html"]=Data(("<!doctype html><meta charset=utf-8><title>Your Porchday archive</title><h1>Your Porchday archive</h1><p>Extract all parts into one folder.</p><ul>"+links+"</ul>").utf8)
            }
        }
        guard entries.values.reduce(0, { $0 + $1.count }) <= Self.limit - 65536 else { throw PorchError.message("A single record exceeds the archive part safety limit.") }
        for (path, bytes) in entries { try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(bytes.count), compressionMethod: .none) { position, count in bytes.subdata(in: Int(position)..<min(Int(position) + count, bytes.count)) } }
        guard let data = archive.data, data.count <= Self.limit else { throw PorchError.message("Archive part exceeds the safety limit.") }; return data
    }
    static func read(_ data: Data) throws -> PortableArchive {
        guard data.count <= limit else { throw PorchError.message("Archive exceeds the 30 MB part limit.") }
        let archive = try Archive(data: data, accessMode: .read)
        var files: [String: Data] = [:], total = 0, count = 0
        for entry in archive {
            count += 1; guard count <= 5000, entry.type == .file, entry.path == "archive.json" || entry.path == "index.html" || entry.path.range(of: #"^(archive-part-[0-9]+\.json|index-part-[0-9]+\.html)$"#,options:.regularExpression) != nil || entry.path.range(of: #"^photos/[a-fA-F0-9-]{36}\.jpg$"#, options: .regularExpression) != nil else { throw PorchError.message("Archive contains an unsupported path or file type.") }
            guard entry.uncompressedSize <= UInt64(limit), files[entry.path] == nil else { throw PorchError.message("Archive has oversized or duplicate entries.") }
            var bytes = Data(); let crc = try archive.extract(entry) { chunk in total += chunk.count; guard total <= limit else { throw PorchError.message("Expanded archive exceeds the safety limit.") }; bytes.append(chunk) }
            guard crc == entry.checksum else { throw PorchError.message("Archive checksum failed.") }; files[entry.path] = bytes
        }
        guard let manifestBytes = files.removeValue(forKey: "archive.json") else { throw PorchError.message("Missing archive.json.") }
        let manifest = try JSONDecoder().decode(JSON.self, from: manifestBytes)
        guard manifest["format"].string == "porchday-archive", manifest["version"].integer == 1, let source = manifest["member_id"].string, UUID(uuidString: source) != nil else { throw PorchError.message("Unsupported archive schema.") }
        for photo in manifest["media"].array { guard let photoID = photo["id"].string, UUID(uuidString:photoID) != nil, let path = photo["path"].string, path == "photos/\(photoID).jpg", let bytes = files[path], photo["mime"].string == "image/jpeg", digest(bytes) == photo["sha256"].string else { throw PorchError.message("A photo is missing or failed its checksum.") } }
        return PortableArchive(manifest: manifest, files: files)
    }
    static func escape(_ text: String) -> String { text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;") }
}

/// Files remain separately protected on disk; importing never retains every photo in memory.
@MainActor struct ArchiveSelection {
    let urls:[URL]
    let secret:String
    let memberID:String
    let entryCount:Int
    let photoCount:Int
    private let photos:[String:Int]
    let orphanPhotoIDs:[String]
    func part(_ index:Int) throws -> PortableArchive { try Self.read(url:urls[index],secret:secret) }
    func photo(_ id:String) throws -> (JSON,Data) { guard let index=photos[id] else { throw PorchError.message("A referenced photo is missing from the selected archive parts.") };let archive=try part(index);guard let meta=archive.manifest["media"].array.first(where:{$0["id"].string==id}),let path=meta["path"].string,let data=archive.files[path] else { throw PorchError.message("An archive photo is missing.") };return(meta,data) }
    private static func read(url:URL,secret:String) throws -> PortableArchive { let size=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0;guard size>0,size<=PortableArchive.limit+1024*1024 else { throw PorchError.message("An archive part exceeds the safety limit.") };let data=try Data(contentsOf:url);return try PortableArchive.read(url.pathExtension.lowercased()=="pgp" ? CryptoVault.unarchive(data,secret:secret) : data) }
    static func load(urls:[URL],secret:String) throws -> ArchiveSelection {
        guard !urls.isEmpty,urls.count<=1000 else { throw PorchError.message("Select all parts of one archive, up to 1000 files at a time.") }
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("porchday-import-"+UUID().uuidString,isDirectory:true);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        var staged:[(Int,URL)]=[],setID:String?,memberID:String?,total:Int?,completions=0,entryCount=0,profileCount=0,photoParts:[String:Int]=[:],recordIDs=Set<String>(),references=Set<String>()
        for url in urls {
            let scoped=url.startAccessingSecurityScopedResource();defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let archive=try read(url:url,secret:secret),set=archive.manifest["archive_set"],index=set["index"].integer ?? 1
            if urls.count>1 && set["id"].string==nil { throw PorchError.message("Select a single legacy archive or a complete multipart archive.") }
            let currentSet=set["id"].string ?? "legacy";if let setID,setID != currentSet { throw PorchError.message("Files belong to different archive sets.") };setID=currentSet
            let owner=archive.manifest["member_id"].string ?? "";if let memberID,memberID != owner { throw PorchError.message("Archive owner mismatch.") };memberID=owner
            if set["complete"].boolean || currentSet=="legacy" { completions += 1;total=set["total"].integer ?? 1 }
            guard index>0,index<=1000,!staged.contains(where:{$0.0==index}) else { throw PorchError.message("Duplicate or invalid archive part number.") }
            let target=directory.appendingPathComponent("part-\(index)."+(url.pathExtension.lowercased()=="pgp" ? "pgp":"zip"));try FileManager.default.copyItem(at:url,to:target)
            try FileManager.default.setAttributes([.protectionKey:FileProtectionType.complete],ofItemAtPath:target.path)
            staged.append((index,target))
            for section in ["posts","comments","reactions"] { for row in archive.manifest[section].array { guard let id=row["id"].string,let created=row["created_at"].string.flatMap(PorchDate.parse),created<=Date(),row["expires_at"] == .null || row["expires_at"].string.flatMap(PorchDate.parse) != nil else { throw PorchError.message("Archive contains invalid record identity or timestamps.") };let unique=section+":"+id+":"+(row["parent_id"].string ?? "");guard recordIDs.insert(unique).inserted else { throw PorchError.message("Duplicate record across archive parts.") };entryCount += 1;for photo in row["payload"]["media"].array { if let id=photo["id"].string { references.insert(id) } } } }
            if archive.manifest["profile"] != .null {
                profileCount += 1
                for slot in ["avatar","cover","background"] { if let id=archive.manifest["profile"][slot]["id"].string { references.insert(id) } }
            }
            for photo in archive.manifest["media"].array { guard let id=photo["id"].string,photoParts[id]==nil else { throw PorchError.message("Duplicate photo across archive parts.") };photoParts[id]=index-1 }
        }
        guard profileCount<=1,completions==1,total==urls.count,Set(staged.map(\.0))==Set(1...urls.count),references.isSubset(of:Set(photoParts.keys)) else { throw PorchError.message("The archive is incomplete. Select every part, including its final completion part.") }
        return ArchiveSelection(urls:staged.sorted{$0.0<$1.0}.map(\.1),secret:secret,memberID:memberID ?? "",entryCount:entryCount,photoCount:photoParts.count,photos:photoParts,orphanPhotoIDs:Array(Set(photoParts.keys).subtracting(references)))
    }
}

@MainActor extension AppModel {
    func exportOwned(plaintext:Bool,progress:(String)->Void) async throws -> (urls:[URL],secret:String?) {
        guard let member else { throw PorchError.message("Sign in first.") }
        let job=try await api.social("/exports",method:"POST",body:.object([:]));guard let jobID=job["id"].string else { throw PorchError.message("Export was not authorized.") }
        let secret=plaintext ? nil:try CryptoVault.randomSecret(),setID=UUID().uuidString.lowercased(),date=PorchDate.string()
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("porchday-export-"+setID,isDirectory:true);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        var urls:[URL]=[],partNumber=1,files:[String:Data]=[:],refs:[JSON]=[],allRefs:[JSON]=[],size=0
        let base:[String:JSON]=["format":.string("porchday-archive"),"version":.number(1),"member_id":.string(member.id),"handle":.string(member.handle),"generated_at":.string(date),"profile":.null,"posts":.array([]),"comments":.array([]),"reactions":.array([]),"media":.array([]),"connections":.array([]),"groups":.array([])]
        var manifest=base
        func flush(final:Bool) async throws {
            if !final && size==0 { return }
            manifest["archive_set"] = .object(["id":.string(setID),"index":.number(Double(partNumber)),"total":final ? .number(Double(partNumber)):.null,"complete":.bool(final)])
            for offset in stride(from:0,to:refs.count,by:1000) { _ = try await api.social("/exports/"+jobID+"/validate",method:"POST",body:.object(["items":.array(Array(refs[offset..<min(offset+1000,refs.count)]))])) }
            if refs.isEmpty { _ = try await api.social("/exports/"+jobID+"/validate",method:"POST",body:.object(["items":.array([])])) }
            let packed=try PortableArchive(manifest:.object(manifest),files:files).zip(),output=try secret.map { try CryptoVault.archive(packed,secret:$0) } ?? packed
            let target=directory.appendingPathComponent(String(format:"porchday-%03d.zip",partNumber)+(secret==nil ? "":".pgp"));try output.write(to:target,options:[.atomic,.completeFileProtection]);urls.append(target)
            partNumber += 1;manifest=base;files=[:];refs=[];size=0
        }
        func append(_ value:JSON,section:String,reference:JSON?=nil,photo:(String,Data)?=nil) async throws {
            let added=try JSONEncoder().encode(value).count*3+(photo?.1.count ?? 0)+1024
            if size+added>PortableArchive.partBudget { try await flush(final:false) }
            guard added<=PortableArchive.partBudget else { throw PorchError.message("A single archive record exceeds the 20 MB part limit.") }
            if section=="profile" { manifest[section]=value } else { manifest[section] = .array((manifest[section]?.array ?? [])+[value]) }
            if let reference { refs.append(reference);allRefs.append(reference) };if let photo { files[photo.0]=photo.1 };size += added
        }
        do {
            for section in ["profile","posts","comments","post_reactions","comment_reactions","media","connections","groups"] {
                var cursor:String?=nil
                repeat {
                    try Task.checkCancellation();progress("Preparing \(section.replacingOccurrences(of:"_",with:" "))…")
                    var query=URLComponents();query.queryItems=[URLQueryItem(name:"section",value:section)]+(cursor.map{[URLQueryItem(name:"cursor",value:$0)]} ?? [])
                    let page=try await api.social("/exports/"+jobID+"?"+(query.percentEncodedQuery ?? ""))
                    let rows=section=="profile" ? (page["profile"] == .null ? []:[page["profile"]]) : page[section].array
                    for row in rows {
                        if section=="connections" || section=="groups" { try await append(row,section:section);continue }
                        let context=row["envelope"]["context"],deadline=PorchDate.minimum([row["effective_expires_at"],row["expires_at"],context["expiresAt"]])
                        if deadline.map({$0<=Date()})==true { continue }
                        guard context["authorId"].string==member.id || (section=="profile" && row["envelope"] == .null) else { throw PorchError.message("Export contained another person's contribution.") }
                        let kind=section=="post_reactions" ? "post_reaction":section=="comment_reactions" ? "comment_reaction":section=="posts" ? "post":section=="comments" ? "comment":section
                        let reference:JSON = .object(["kind":.string(kind),"id":row["export_id"],"revision":context["revision"],"expires_at":deadline.map{.string(PorchDate.string($0))} ?? .null])
                        if section=="profile" { if row["envelope"] != .null { let payload=try await vault.open(row);try await append(payload,section:"profile",reference:reference) };continue }
                        if section=="media" {
                            guard let id=row["id"].string else { throw PorchError.message("Invalid photo identifier.") }
                            let raw=try await api.bytes("/api/v1/exports/\(jobID)/media/\(id)/bytes"),envelope=try JSONDecoder().decode(JSON.self,from:raw),payload=try await vault.open(.object(["id":.string(id),"envelope":envelope]))
                            guard let encoded=payload["bytes"].string,let image=Data(base64Encoded:encoded) else { throw PorchError.message("Invalid encrypted photo.") };_ = try PhotoPipeline.safelyDecode(image)
                            let path="photos/\(id).jpg",meta:JSON = .object(["id":.string(id),"path":.string(path),"mime":.string("image/jpeg"),"alt":payload["alt"],"width":payload["width"],"height":payload["height"],"sha256":.string(PortableArchive.digest(image)),"post_id":row["post_id"],"profile_id":row["profile_member_id"],"group_id":row["group_id"],"slot":row["slot"],"created_at":context["createdAt"],"expires_at":deadline.map{.string(PorchDate.string($0))} ?? .null]);try await append(meta,section:"media",reference:reference,photo:(path,image))
                        } else {
                            let payload=try await vault.open(row),entry:JSON = .object(["id":context["id"],"created_at":context["createdAt"],"expires_at":deadline.map{.string(PorchDate.string($0))} ?? .null,"audience":context["audience"],"parent_id":context["parentId"],"group_id":context["groupId"],"payload":payload]);try await append(entry,section:section.contains("reactions") ? "reactions":section,reference:reference)
                        }
                    };cursor=page["next_cursor"].string
                } while cursor != nil
            }
            try await flush(final:true);for offset in stride(from:0,to:allRefs.count,by:1000) { _ = try await api.social("/exports/"+jobID+"/validate",method:"POST",body:.object(["items":.array(Array(allRefs[offset..<min(offset+1000,allRefs.count)]))])) };_ = try await api.social("/exports/"+jobID,method:"DELETE");return(urls,secret)
        } catch { _ = try? await api.social("/exports/"+jobID,method:"DELETE");try? FileManager.default.removeItem(at:directory);throw error }
    }
    private func importPhoto(_ selection:ArchiveSelection,id:String,parent:String,expiry:Date?) async throws -> JSON {
        guard let member else { throw PorchError.message("Sign in first.") }
        let (metadata,bytes)=try selection.photo(id),image=try PhotoPipeline.prepare(bytes)
        let meta:JSON = .object(["id":.string(image.id),"alt":metadata["alt"],"mime":.string("image/jpeg"),"name":.string("photo.jpg"),"width":.number(Double(image.width)),"height":.number(Double(image.height))])
        let envelope=try await vault.seal(meta.replacing("bytes",with:.string(image.bytes.base64EncodedString())),member:member,kind:"media",audience:"only_me",id:image.id,parent:parent,expiry:expiry)
        let packed=try JSONEncoder().encode(envelope),upload=try await api.social("/media",method:"POST",body:.object(["id":.string(image.id),"envelope":envelope,"byte_size":.number(Double(packed.count))]))
        guard let url=upload["upload_url"].string else { throw PorchError.message("Upload is unavailable.") };_ = try await api.bytes(url,method:"PUT",body:packed);return meta
    }
    func importOwned(_ selection: ArchiveSelection) async throws -> Int {
        guard let member else { throw PorchError.message("Sign in first.") }
        let sourceID=selection.memberID,jobID=UUID().uuidString.lowercased()
        var imported=0
        func importEntry(_ kind:String,_ row:JSON) async throws {
            try Task.checkCancellation()
            let expiry=row["expires_at"].string.flatMap(PorchDate.parse);if expiry.map({$0<=Date()})==true { return }
            guard let oldID=row["id"].string,let created=row["created_at"].string.flatMap(PorchDate.parse),created<=Date() else { throw PorchError.message("Invalid archive timestamp or identity.") }
            let newID=UUID().uuidString.lowercased();var payload=row["payload"],media:[JSON]=[]
            for photo in payload["media"].array { guard let id=photo["id"].string else { throw PorchError.message("Invalid photo reference.") };media.append(try await importPhoto(selection,id:id,parent:newID,expiry:expiry)) }
            if kind=="reaction" { payload=payload.replacing("text",with:.string("Imported reaction: "+(payload["emoji"].string ?? "unknown"))) }
            let provenance:JSON = .object(["kind":.string(kind),"member_id":.string(sourceID),"source_id":.string(oldID),"parent_id":row["parent_id"],"original_audience":row["audience"],"original_group_id":row["group_id"],"prior_provenance":payload["provenance"]])
            payload=payload.replacing("media",with:.array(media)).replacing("reactionSecret",with:.string(try CryptoVault.randomSecret())).replacing("provenance",with:provenance)
            let original:JSON = .object(["id":.string(newID),"kind":.string("post"),"createdAt":.string(PorchDate.string(created)),"revision":.number(1)])
            let envelope=try await vault.seal(payload,member:member,kind:"post",audience:"only_me",id:newID,expiry:expiry,original:original)
            let result=try await api.social("/imports",method:"POST",body:.object(["id":.string(jobID),"posts":.array([.object(["envelope":envelope,"source_id":.string("\(sourceID):\(kind):\(oldID)"),"media_ids":.array(media.map{$0["id"]})])])]))
            imported += result["imported"].array.count
        }
        for partIndex in selection.urls.indices {
            let archive=try selection.part(partIndex)
            for (kind,section) in [("post","posts"),("comment","comments"),("reaction","reactions")] { for row in archive.manifest[section].array { try await importEntry(kind,row) } }
            if archive.manifest["profile"] != .null {
                var profile=archive.manifest["profile"];var attachments:[(String,String)]=[]
                for slot in ["avatar","cover","background"] { if let id=profile[slot]["id"].string { let (meta,_)=try selection.photo(id);let expiry=meta["expires_at"].string.flatMap(PorchDate.parse);if expiry.map({$0<=Date()})==true { profile=profile.replacing(slot,with:.null);continue };let photo=try await importPhoto(selection,id:id,parent:member.id,expiry:expiry);profile=profile.replacing(slot,with:photo);attachments.append((photo["id"].string ?? "",slot)) } }
                let previous=try await api.social("/me")["envelope"]["context"],original:JSON = .object(["id":.string(member.id),"kind":.string("profile"),"createdAt":.string(PorchDate.string()),"revision":.number(Double((previous["revision"].integer ?? 0)+1))])
                let envelope=try await vault.seal(profile,member:member,kind:"profile",audience:"only_me",id:member.id,original:original)
                _ = try await api.social("/imports",method:"POST",body:.object(["id":.string(jobID),"posts":.array([]),"profile":.object(["envelope":envelope])]))
                for (id,slot) in attachments { _ = try await api.social("/media/"+id+"/attachment",method:"PUT",body:.object(["kind":.string("profile"),"target_id":.string(member.id),"slot":.string(slot)])) }
            }
        }
        for id in selection.orphanPhotoIDs {
            let (meta,_)=try selection.photo(id),row:JSON = .object(["id":.string(id),"created_at":meta["created_at"] == .null ? .string(PorchDate.string()):meta["created_at"],"expires_at":meta["expires_at"],"audience":.string("only_me"),"parent_id":meta["post_id"] == .null ? meta["group_id"]:meta["post_id"],"group_id":meta["group_id"],"payload":.object(["text":.string("Imported photo"),"media":.array([meta])])])
            try await importEntry("photo",row)
        }
        return imported
    }
}
