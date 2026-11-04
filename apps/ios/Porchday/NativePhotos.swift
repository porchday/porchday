import Foundation

@MainActor final class NativePhotos {
    let model: AppModel
    let member: Member
    let generation: Int
    init(_ model: AppModel) throws {
        guard let member = model.member, model.vault.unlocked else { throw PorchError.message("Unlock your account first.") }
        self.model = model; self.member = member; self.generation = model.authenticationGeneration
    }
    func check() throws { guard model.member?.id == member.id, model.authenticationGeneration == generation, model.vault.unlocked, !Task.isCancelled else { throw CancellationError() } }
    func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON {
        try check(); if method != "GET" { try member.access.requireSocialWrite() }
        let result = try await model.api.social(path, method: method, body: body); try check(); return result
    }
    static func query(_ fields: [String: String]) -> String { var c = URLComponents(); c.queryItems = fields.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }; return c.percentEncodedQuery ?? "" }
    func seal(_ payload: JSON, context: JSON, snapshot: String? = nil) async throws -> JSON {
        try check(); let result: JSON
        if let snapshot { result = try await model.vault.sealSnapshot(payload, member: member, context: context, path: snapshot) }
        else { result = try await model.vault.seal(payload, member: member, kind: context["kind"].string!, audience: context["audience"].string!, id: context["id"].string!, group: context["groupId"].string, parent: context["parentId"].string, expiry: context["expiresAt"].string.flatMap(PorchDate.parse), original: context) }
        try check(); return result
    }
    func open(_ photo: JSON, grant: JSON) async throws -> JSON {
        try check(); let c = grant["envelope"]["context"]
        guard grant["photo_id"] == photo["id"], c["id"] == grant["id"], c["parentId"] == photo["id"], c["kind"].string == "photo", c["groupId"] == grant["album_id"], c["audience"] == grant["audience"], c["photoDate"] == photo["photo_date"], c["revision"] == photo["revision"] else { throw PorchError.message("Photo identity or date does not match its signed metadata.") }
        let content = try await model.vault.open(grant)
        guard content["media"].array.count == 1, let media = content["media"].array.first, media["id"] == grant["media_id"], let owner = photo["owner_id"].string, let device = content["photoProof"]["statement"]["deviceId"].string else { throw PorchError.message("Photo metadata is incomplete.") }
        let expected = try NativePhotoContract.statement(id: photo["id"].string!, owner: owner, device: device, revision: photo["revision"].integer ?? 0, date: photo["photo_date"].string ?? "", expiry: NativePhotoContract.expiry(photo["expires_at"]), hash: content["photoProof"]["statement"]["sha256"].string ?? "", media: media)
        try await model.vault.verifySigned(content["photoProof"], owner: owner, expected: expected); try check(); return content
    }
    func read(_ photo: JSON, grants: [JSON]? = nil) async throws -> (content: JSON, payload: JSON, bytes: Data) {
        var last: Error = PorchError.message("Restore the keys for this photo.")
        for grant in grants ?? photo["grants"].array {
            do {
                let content = try await open(photo, grant: grant), media = content["media"].array[0]
                let envelope = try await request("/media/" + (media["id"].string ?? "") + "/bytes")
                guard envelope["context"]["parentId"] == photo["id"], envelope["context"]["kind"].string == "media" else { throw PorchError.message("Photo bytes belong to different content.") }
                let payload = try await model.vault.open(.object(["id": media["id"], "envelope": envelope]))
                guard payload["mime"] == media["mime"], let bytes = payload["bytes"].string.flatMap({ Data(base64Encoded: $0) }), NativePhotoContract.hash(bytes) == content["photoProof"]["statement"]["sha256"].string else { throw PorchError.message("Photo bytes do not match the owner signature.") }
                try check(); return (content, payload, bytes)
            } catch { last = error }
        }; throw last
    }
    func upload(_ payload: JSON, context: JSON, snapshot: String? = nil, refreshID: String? = nil) async throws {
        let envelope = try await seal(payload, context: context, snapshot: snapshot), bytes = try JSONEncoder().encode(envelope)
        guard bytes.count <= 22_020_096 else { throw PorchError.message("This encrypted photo is too large for its audience.") }
        var body: JSON = .object(["id": context["id"], "envelope": envelope, "byte_size": .number(Double(bytes.count))])
        if let refreshID { body = body.replacing("photo_refresh_id", with: .string(refreshID)) }
        let reservation = try await request("/media", method: "POST", body: body)
        guard let path = reservation["upload_url"].string else { throw PorchError.message("Upload was not authorized.") }
        try check(); _ = try await model.api.bytes(path, method: "PUT", body: bytes); try check()
    }
    func photo(_ id: String) async throws -> JSON { try await request("/photos/" + id)["photo"] }
    func publish(_ draft: PreparedPhoto, date: String, audience: String, album: String?, expiry: Date?, id: String? = nil, source: JSON? = nil) async throws {
        let id = id ?? draft.id, day = try NativePhotoContract.date(date), deadline: JSON = expiry.map { .string(PorchDate.string($0)) } ?? .null
        func existing() async throws -> Bool {
            do {
                let row = try await photo(id), opened = try await read(row)
                guard row["owner_id"].string == member.id, row["photo_date"].string == day, NativePhotoContract.expiry(row["expires_at"]) == deadline,
                      NativePhotoContract.hash(draft.bytes) == opened.content["photoProof"]["statement"]["sha256"].string,
                      opened.content["media"].array.first?["alt"].string == draft.alt,
                      row["grants"].array.contains(where: { $0["album_id"] == .null && $0["audience"].string == audience }),
                      album == nil || row["grants"].array.contains(where: { $0["album_id"].string == album }) else { throw PorchError.message("This photo was already shared with different settings. Review it before trying again.") }
                return true
            } catch PorchError.api(let code, _, _) where code == "NOT_FOUND" { return false }
        }
        if try await existing() { return }
        var grants: [JSON] = []
        for destination in [(audience, Optional<String>.none)] + (album.map { [("album", Optional($0))] } ?? []) {
            let mediaID = UUID().uuidString.lowercased()
            let metadata: JSON = .object(["id": .string(mediaID), "mime": .string(draft.mime), "name": .string(draft.mime == "image/jpeg" ? "photo.jpg" : "video." + VideoContainer.fileExtension(draft.mime)), "alt": .string(draft.alt), "caption": .string(draft.caption), "width": .number(Double(draft.width)), "height": .number(Double(draft.height)), "tags": .array(draft.tags.map(\.json)), "poster": .string(draft.poster)])
            let context = NativePhotoContract.context(kind: "media", id: mediaID, parent: id, audience: destination.0, album: destination.1, expiry: deadline)
            try await upload(metadata.replacing("bytes", with: .string(draft.bytes.base64EncodedString())), context: context)
            let proof = try model.vault.sign(NativePhotoContract.statement(id: id, owner: member.id, device: model.vault.device!.id, revision: 1, date: day, expiry: deadline, hash: NativePhotoContract.hash(draft.bytes), media: metadata))
            let envelope = try await seal(.object(["media": .array([metadata]), "photoProof": proof]), context: NativePhotoContract.context(kind: "photo", id: UUID().uuidString.lowercased(), parent: id, audience: destination.0, album: destination.1, expiry: deadline, date: day))
            grants.append(.object(["envelope": envelope, "media_id": .string(mediaID)]))
        }
        var body: JSON = .object(["id": .string(id), "photo_date": .string(day), "expires_at": deadline, "grants": .array(grants)])
        if let source { body = body.replacing("source_media_id", with: .string(id)).replacing("source_date", with: source) }
        do { _ = try await request("/photos", method: "POST", body: body) } catch { if try await existing() { return }; throw error }
    }
    func add(_ photoID: String, to album: String) async throws {
        let row = try await photo(photoID)
        guard row["owner_id"].string == member.id else { throw PorchError.message("Only your own uploads can be added.") }
        if row["grants"].array.contains(where: { $0["album_id"].string == album }) { return }
        let opened = try await read(row), media = opened.content["media"].array[0].replacing("id", with: .id())
        let context = NativePhotoContract.context(kind: "media", id: media["id"].string!, parent: photoID, audience: "album", album: album, expiry: NativePhotoContract.expiry(row["expires_at"]))
        try await upload(opened.payload.replacing("id", with: media["id"]), context: context)
        let envelope = try await seal(opened.content.replacing("media", with: .array([media])), context: NativePhotoContract.context(kind: "photo", id: UUID().uuidString.lowercased(), parent: photoID, audience: "album", album: album, expiry: NativePhotoContract.expiry(row["expires_at"]), date: row["photo_date"].string, revision: row["revision"].integer ?? 1))
        do { _ = try await request("/photos/" + photoID + "/grants", method: "POST", body: .object(["envelope": envelope, "media_id": media["id"]])) }
        catch { let latest = try await photo(photoID); if latest["grants"].array.contains(where: { $0["album_id"].string == album }) { return }; throw error }
    }
    func attachmentProof(media: String, post: String, date: String, revision: Int) throws -> JSON {
        try model.vault.sign(.object(["v": .number(1), "purpose": .string("porchday-attachment-date"), "mediaId": .string(media), "postId": .string(post), "ownerId": .string(member.id), "deviceId": .string(model.vault.device!.id), "date": .string(try NativePhotoContract.date(date)), "revision": .number(Double(revision))]))
    }
    func adopt(_ entry: JSON, album: String) async throws {
        let mediaID = entry["id"].string!, postID = entry["post"]["id"].string!
        let dateInfo = try await request("/media/" + mediaID + "/photo-date")
        if let id = dateInfo["photo_id"].string { try await add(id, to: album); return }
        let post = try await request("/posts/" + postID)["post"]
        guard post["author_id"].string == member.id else { throw PorchError.message("Only your own uploads can be added.") }
        let content = try await model.vault.open(post)
        guard let metadata = content["media"].array.first(where: { $0["id"].string == mediaID }) else { throw PorchError.message("Attachment is missing from its signed post.") }
        let envelope = try await request("/media/" + mediaID + "/bytes")
        guard envelope["context"]["parentId"].string == postID, envelope["context"]["authorId"].string == member.id else { throw PorchError.message("Attachment source mismatch.") }
        let payload = try await model.vault.open(.object(["id": .string(mediaID), "envelope": envelope]))
        guard let bytes = payload["bytes"].string.flatMap({ Data(base64Encoded: $0) }), payload["mime"] == metadata["mime"] else { throw PorchError.message("Attachment bytes unavailable.") }
        let day = dateInfo["date"]["photo_date"].string ?? entry["day"].string ?? PhotoCalendar.day(Date())
        if dateInfo["date"]["photo_date"] != .null { try await verifyAttachment(dateInfo["date"], media: mediaID, post: postID, owner: member.id, day: day) }
        let expiry = [post["expires_at"], envelope["context"]["expiresAt"]].compactMap { $0.string.flatMap(PorchDate.parse) }.min()
        let draft = PreparedPhoto(bytes: bytes, width: metadata["width"].integer ?? 0, height: metadata["height"].integer ?? 0, alt: metadata["alt"].string ?? "", mime: metadata["mime"].string ?? "image/jpeg", poster: metadata["poster"].string ?? "", caption: metadata["caption"].string ?? "", tags: PersonTag.parse(metadata["tags"]))
        let proof = try attachmentProof(media: mediaID, post: postID, date: day, revision: (dateInfo["date"]["revision"].integer ?? 0) + 1)
        try await publish(draft, date: day, audience: "only_me", album: album, expiry: expiry, id: mediaID, source: proof)
    }
    func verifyAttachment(_ record: JSON, media: String, post: String, owner: String, day: String) async throws {
        let expected: JSON = .object(["v": .number(1), "purpose": .string("porchday-attachment-date"), "mediaId": .string(media), "postId": .string(post), "ownerId": .string(owner), "deviceId": record["proof"]["statement"]["deviceId"], "date": .string(try NativePhotoContract.date(day)), "revision": record["revision"]])
        guard record["media_id"].string == media, record["photo_date"].string == day else { throw PorchError.message("Photo date mismatch.") }
        try await model.vault.verifySigned(record["proof"], owner: owner, expected: expected)
    }
    func updateDate(_ row: JSON, date: String) async throws {
        guard row["owner_id"].string == member.id else { throw PorchError.message("Only the owner can change the photo date.") }
        var envelopes: [JSON] = []
        for grant in row["grants"].array {
            let content = try await open(row, grant: grant), media = content["media"].array[0]
            let statement = try NativePhotoContract.statement(id: row["id"].string!, owner: member.id, device: model.vault.device!.id, revision: (row["revision"].integer ?? 0) + 1, date: date, expiry: NativePhotoContract.expiry(row["expires_at"]), hash: content["photoProof"]["statement"]["sha256"].string!, media: media)
            let context = grant["envelope"]["context"].replacing("photoDate", with: .string(date)).replacing("revision", with: .number(Double((row["revision"].integer ?? 0) + 1)))
            envelopes.append(try await seal(content.replacing("photoProof", with: model.vault.sign(statement)), context: context, snapshot: "/photos/" + row["id"].string! + "/grants/" + grant["id"].string! + "/audience"))
        }
        var body: JSON = .object(["photo_date": .string(date), "expected_revision": row["revision"], "envelopes": .array(envelopes)])
        if let media = row["source_media_id"].string, let post = row["source_post_id"].string {
            do { let info = try await request("/media/" + media + "/photo-date"); body = body.replacing("source_date", with: try attachmentProof(media: media, post: post, date: date, revision: (info["date"]["revision"].integer ?? 0) + 1)) }
            catch PorchError.api(let code, _, _) where code == "NOT_FOUND" { }
        }
        _ = try await request("/photos/" + row["id"].string!, method: "PUT", body: body)
    }
    func refresh(_ photo: JSON, grant: JSON) async throws {
        let opened = try await read(photo, grants: [grant]), media = opened.content["media"].array[0].replacing("id", with: .id())
        let path = "/photos/" + photo["id"].string! + "/grants/" + grant["id"].string! + "/refresh-audience"
        var fields = grant["envelope"]["context"].object; fields.removeValue(forKey: "photoDate")
        let context = JSON.object(fields).replacing("id", with: media["id"]).replacing("kind", with: .string("media")).replacing("createdAt", with: .string(PorchDate.string()))
        try await upload(opened.payload.replacing("id", with: media["id"]), context: context, snapshot: path, refreshID: grant["id"].string)
        let envelope = try await seal(opened.content.replacing("media", with: .array([media])), context: grant["envelope"]["context"], snapshot: path)
        _ = try await request("/photos/" + photo["id"].string! + "/grants/" + grant["id"].string! + "/refresh", method: "POST", body: .object(["envelope": envelope, "media_id": media["id"], "expected_media_id": grant["media_id"], "expected_revision": photo["revision"]]))
    }
}
