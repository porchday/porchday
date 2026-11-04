import Foundation

enum NativeArchiveIdentity {
    /// Matches the web importer so retries across platforms address the same records.
    static func id(owner: String, source: String, kind: String, id: String) throws -> String {
        let input = JSON.array(["porchday-import-v1", owner, source, kind, id].map(JSON.string))
        let hash = NativePhotoContract.hash(Data(try input.serialized().utf8))
        let chars = Array(hash)
        func slice(_ start: Int, _ end: Int) -> String { String(chars[start..<end]) }
        return "\(slice(0,8))-\(slice(8,12))-5\(slice(13,16))-a\(slice(17,20))-\(slice(20,32))"
    }
}

@MainActor extension NativePhotos {
    func importCollections(_ selection: ArchiveSelection, albums: [JSON], photos: [JSON]) async throws -> Int {
        let source = selection.memberID
        var mapped: [String:String] = [:], count = 0
        for original in albums {
            try check()
            let old = original["id"].string!, id = try NativeArchiveIdentity.id(owner: member.id, source: source, kind: "album", id: old)
            func exists() async throws -> Bool {
                do {
                    let result = try await request("/albums/" + id), content = try await model.vault.open(result["album"])
                    guard result["album"]["owner_id"].string == member.id,
                          content["provenance"]["source_member_id"].string == source, content["provenance"]["source_id"].string == old,
                          result["members"].array.allSatisfy({ $0["member_id"].string == member.id })
                    else { throw PorchError.message("This imported album is now shared or has different provenance. Import stopped before adding private photos.") }
                    return true
                } catch PorchError.api(let code, _, _) where code == "NOT_FOUND" { return false }
            }
            if try await !exists() {
                let content: JSON = .object(["name": original["payload"]["name"], "description": original["payload"]["description"] == .null ? .string("") : original["payload"]["description"], "provenance": .object(["source_member_id": .string(source), "source_id": .string(old)])])
                let envelope = try await seal(content, context: NativePhotoContract.context(kind: "album", id: id, parent: nil, audience: "only_me", album: nil, expiry: .null))
                do { _ = try await request("/albums", method: "POST", body: .object(["envelope": envelope])) }
                catch { if try await !exists() { throw error } }
            }
            mapped[old] = id
        }
        for original in photos {
            try check()
            let metadata = original["payload"]["media"].array[0], (record, bytes) = try selection.photo(metadata["id"].string!)
            let expiry = try PortableArchive.photoDeadline(record, parent: original["expires_at"].string.flatMap(PorchDate.parse))
            if expiry.map({ $0 <= Date() }) == true { continue }
            let mime = record["mime"].string ?? ""
            if mime == "image/jpeg" { _ = try PhotoPipeline.safelyDecode(bytes) }
            else { guard try VideoContainer.mime(bytes) == mime else { throw PorchError.message("Archive video format mismatch.") }; _ = try await VideoPipeline.prepare(bytes) }
            let id = try NativeArchiveIdentity.id(owner: member.id, source: source, kind: "photo", id: original["id"].string!)
            var linked: JSON?
            do {
                let current = try await photo(id)
                if let media = current["source_media_id"].string {
                    let mapping = try await importedSource(source, original: original)
                    guard mapping?["media_id"].string == media, mapping?["post_id"] == current["source_post_id"] else { throw PorchError.message("Imported photo has a different source attachment.") }
                    linked = mapping
                }
            } catch PorchError.api(let code, _, _) where code == "NOT_FOUND" { }
            let draft = PreparedPhoto(bytes: bytes, width: record["width"].integer ?? 0, height: record["height"].integer ?? 0, alt: metadata["alt"].string ?? "", mime: mime, poster: record["poster"].string ?? "", caption: metadata["caption"].string ?? "", tags: PersonTag.parse(metadata["tags"]))
            try await publish(draft, date: original["photo_date"].string!, audience: "only_me", album: nil, expiry: expiry, id: id, existingSource: linked)
            for old in original["album_ids"].array { if let album = mapped[old.string ?? ""] { try await add(id, to: album, privateOnly: true) } }
            count += 1
        }
        return count
    }
    private func importedSource(_ source: String, original: JSON) async throws -> JSON? {
        guard let oldPost = original["source_post_id"].string, let oldMedia = original["source_media_id"].string else { return nil }
        let postID = try NativeArchiveIdentity.id(owner: member.id, source: source, kind: "post", id: oldPost)
        let post: JSON
        do { post = try await request("/posts/" + postID)["post"] }
        catch PorchError.api(let code, _, _) where code == "NOT_FOUND" { return nil }
        let content = try await model.vault.open(post)
        guard post["author_id"].string == member.id, content["provenance"]["source_member_id"].string == source, content["provenance"]["source_id"].string == oldPost else { throw PorchError.message("Imported source post has different provenance.") }
        guard let mapped = content["provenance"]["source_media"].array.first(where: { $0["source_id"].string == oldMedia }), post["media"].array.contains(where: { $0["id"] == mapped["media_id"] }) else { return nil }
        return .object(["post_id": .string(postID), "media_id": mapped["media_id"]])
    }
    func restoreSources(_ source: String, photos: [JSON]) async throws {
        for original in photos {
            try check()
            if original["expires_at"].string.flatMap(PorchDate.parse).map({ $0 <= Date() }) == true { continue }
            guard let mapping = try await importedSource(source, original: original) else { continue }
            let id = try NativeArchiveIdentity.id(owner: member.id, source: source, kind: "photo", id: original["id"].string!), current = try await photo(id)
            if current["source_media_id"] != .null {
                guard current["source_media_id"] == mapping["media_id"], current["source_post_id"] == mapping["post_id"] else { throw PorchError.message("Imported photo has a different source attachment.") }
                continue
            }
            let info = try await request("/media/" + mapping["media_id"].string! + "/photo-date")
            let proof = try attachmentProof(media: mapping["media_id"].string!, post: mapping["post_id"].string!, date: current["photo_date"].string!, revision: (info["date"]["revision"].integer ?? 0) + 1)
            do { _ = try await request("/photos/" + id + "/source", method: "POST", body: .object(["media_id": mapping["media_id"], "source_date": proof])) }
            catch { let latest = try await photo(id); guard latest["source_media_id"] == mapping["media_id"], latest["source_post_id"] == mapping["post_id"] else { throw error } }
        }
    }
}
