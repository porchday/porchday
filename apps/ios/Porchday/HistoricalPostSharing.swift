import Foundation

/// Re-encrypt only the author's post and live photos. Existing comments and
/// reactions retain their own authors and encrypted audiences.
@MainActor enum HistoricalPostSharing {
    struct IO {
        let readPost: @MainActor (String) async throws -> JSON
        let readAudience: @MainActor (String) async throws -> JSON
        let readPhoto: @MainActor (String) async throws -> JSON
        let open: @MainActor (JSON) async throws -> JSON
        let seal: @MainActor (JSON, JSON, JSON) async throws -> JSON
        let sign: @MainActor (JSON) throws -> JSON
        let reservePhoto: @MainActor (JSON) async throws -> JSON
        let uploadPhoto: @MainActor (String, Data) async throws -> Void
        let publish: @MainActor (String, JSON) async throws -> JSON
        let validatePhoto: @MainActor (JSON) throws -> Void
        let check: @MainActor () throws -> Void
    }

    static let unconfirmed = "Sharing earlier posts was not confirmed. Try again to check their status."

    /// Every invocation reads a fresh source and consent-filtered audience.
    /// Never replay an uncertain write or delete an uncertain photo upload.
    static func refresh(postID: String, memberID: String, io: IO, now: Date = Date()) async throws {
        try io.check()
        let source = try await io.readPost(postID)["post"]
        try io.check()
        let context = source["envelope"]["context"]
        guard source["id"].string == postID, source["author_id"].string == memberID,
              context["id"].string == postID, context["authorId"].string == memberID,
              context["kind"].string == "post", context["parentId"] == .null,
              context["groupId"] == .null, source["group_id"] == .null,
              ["connections", "friends", "family"].contains(context["audience"].string ?? ""),
              let revision = context["revision"].integer, revision > 0, revision < 9_007_199_254_740_991,
              let created = context["createdAt"].string.flatMap(PorchDate.parse), created <= now.addingTimeInterval(300),
              sameDeadline(source["expires_at"], context["expiresAt"]),
              context["expiresAt"] == .null || context["expiresAt"].string.flatMap(PorchDate.parse).map({ $0 > now }) == true
        else { throw PorchError.message("This post cannot be shared with an updated audience.") }

        let audience = try await io.readAudience(postID)
        try io.check()
        guard let epoch = audience["epoch"].integer, epoch >= 0,
              case .array(let devices) = audience["devices"], !devices.isEmpty,
              case .array(let pending) = audience["pending_members"], pending.isEmpty else {
            throw PorchError.message("Sharing earlier posts is waiting for encryption setup.")
        }
        let originalPayload = try await io.open(source)
        try io.check()
        guard case .array(let livePhotos) = source["media"] else { throw PorchError.message("The post's photo list is unavailable.") }
        let liveIDs = livePhotos.compactMap { $0["id"].string }
        guard liveIDs.count <= 20, liveIDs.count == livePhotos.count, Set(liveIDs).count == liveIDs.count else {
            throw PorchError.message("The post's photo list changed. Try again.")
        }
        // An expired attachment may still have a reference in the encrypted
        // payload. Drop it; never resurrect it by creating a replacement.
        let references = originalPayload["media"].array.filter { item in
            item["id"].string.map { liveIDs.contains($0) } == true
        }
        guard references.count == liveIDs.count,
              Set(references.compactMap { $0["id"].string }) == Set(liveIDs) else {
            throw PorchError.message("The post's encrypted photo references do not match its attachments.")
        }

        var photos: [JSON] = []
        for reference in references {
            try io.check()
            guard let oldID = reference["id"].string,
                  let stored = livePhotos.first(where: { $0["id"].string == oldID }) else { throw PorchError.message("A photo reference is unavailable.") }
            let oldEnvelope = try await io.readPhoto(oldID)
            try io.check()
            let oldContext = oldEnvelope["context"]
            guard oldContext == stored["envelope"]["context"],
                  oldEnvelope["recipients"] == stored["envelope"]["recipients"],
                  oldContext["id"].string == oldID, oldContext["kind"].string == "media",
                  oldContext["authorId"].string == memberID, oldContext["parentId"].string == postID,
                  oldContext["audience"] == context["audience"], oldContext["groupId"] == .null else {
                throw PorchError.message("A photo does not match this post.")
            }
            let payload = try await io.open(.object(["id": .string(oldID), "author_id": .string(memberID), "envelope": oldEnvelope]))
            try io.check()
            try io.validatePhoto(payload)
            let newID = UUID().uuidString.lowercased()
            let expiry = PorchDate.minimum([context["expiresAt"], oldContext["expiresAt"]])
            if let expiry, expiry <= Date() { throw PorchError.message("A photo expired before it could be shared.") }
            let photoContext: JSON = .object([
                "id": .string(newID), "kind": .string("media"), "audience": context["audience"],
                "parentId": .string(postID), "groupId": .null,
                "createdAt": .string(PorchDate.string()), "revision": .number(1),
                "expiresAt": expiry.map { .string(PorchDate.string($0)) } ?? .null
            ])
            let envelope = try await io.seal(payload.replacing("id", with: .string(newID)), photoContext, audience)
            try io.check()
            let packed = try JSONEncoder().encode(envelope)
            let reservation = try await io.reservePhoto(.object(["id": .string(newID), "envelope": envelope, "byte_size": .number(Double(packed.count)), "history_post_id": .string(postID), "history_source_revision": .number(Double(revision))]))
            try io.check()
            guard reservation["upload_url"].string == "/api/v1/media/\(newID)/bytes" else {
                throw PorchError.message("Photo upload was not authorized.")
            }
            try await io.uploadPhoto("/api/v1/media/\(newID)/bytes", packed)
            try io.check()
            photos.append(reference.replacing("id", with: .string(newID)))
        }

        var payload = originalPayload
        if originalPayload["media"] != .null { payload = payload.replacing("media", with: .array(photos)) }
        let nextContext = context.replacing("revision", with: .number(Double(revision + 1)))
        let envelope = try await io.seal(payload, nextContext, audience)
        try io.check()
        let lifecycle = try io.sign(.object([
            "purpose": .string("porchday-lifecycle"), "id": .string(postID),
            "revision": .number(Double(revision + 1)), "expiresAt": context["expiresAt"]
        ]))
        let replacementIDs = photos.map { $0["id"] }
        let body: JSON = .object([
            "envelope": envelope, "lifecycle": lifecycle,
            "source_revision": .number(Double(revision)), "source_expires_at": source["expires_at"],
            "source_media_ids": .array(references.map { $0["id"] }), "media_ids": .array(replacementIDs)
        ])
        var writeError: Error?
        do { _ = try await io.publish(postID, body) } catch { writeError = error }
        try io.check()
        // Even a lost successful response is settled by the exact committed
        // envelope and attachments. A failed read is not permission to retry.
        let readback: JSON
        do { readback = try await io.readPost(postID)["post"] }
        catch { throw PorchError.message(unconfirmed) }
        try io.check()
        let actualIDs = readback["media"].array.compactMap { $0["id"].string }
        if readback["envelope"] == envelope,
           actualIDs.count == replacementIDs.count,
           Set(actualIDs) == Set(replacementIDs.compactMap(\.string)) { return }
        if let writeError { throw writeError }
        throw PorchError.message(unconfirmed)
    }

    private static func sameDeadline(_ a: JSON, _ b: JSON) -> Bool {
        if a == .null || b == .null { return a == b }
        guard let left = a.string.flatMap(PorchDate.parse), let right = b.string.flatMap(PorchDate.parse) else { return false }
        return left == right
    }
}
