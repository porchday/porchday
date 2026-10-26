import Foundation

@MainActor struct ReactionSession {
    let memberID: String
    let deviceID: String
    let fingerprint: String
    let generation: Int
    init(_ model: AppModel) throws {
        guard let member = model.member, let device = model.vault.device, device.memberID == member.id else { throw PorchError.message("Unlock your keys first.") }
        memberID = member.id; deviceID = device.id; fingerprint = device.fingerprint; generation = model.authenticationGeneration
    }
    func current(_ model: AppModel, write: Bool = false) -> Bool {
        model.member?.id == memberID && model.member?.access.managesData == true && model.authenticationGeneration == generation && model.vault.device?.id == deviceID && model.vault.device?.fingerprint == fingerprint && (!write || (model.canWriteSocial && model.vault.device?.revoked == false))
    }
    func require(_ model: AppModel, write: Bool = false) throws {
        try Task.checkCancellation()
        guard current(model, write: write) else { throw CancellationError() }
    }
}
struct EmojiLibrarySnapshot {
    let revision: Int
    let envelope: JSON
    let entries: [ReactionValue]
    static func revision(_ response: JSON) throws -> Int {
        let value = response["revision"] == .null ? response["envelope"]["context"]["revision"]:response["revision"]
        if value == .null { return 0 }
        guard let revision = value.integer, revision >= 0, value == .number(Double(revision)) else { throw PorchError.message("Invalid emoji collection revision.") }
        return revision
    }
}
@MainActor enum EmojiLibraryUpdate {
    static func merge(_ incoming: [ReactionValue], read: () async throws -> EmojiLibrarySnapshot, write: ([ReactionValue],EmojiLibrarySnapshot) async throws -> Void, ensureCurrent: () throws -> Void) async throws -> [ReactionValue] {
        for attempt in 0..<3 {
            try ensureCurrent()
            let previous = try await read(), entries = try EmojiLibraryPayload.merge(previous.entries,incoming)
            try ensureCurrent()
            if entries == previous.entries { return entries }
            do { try await write(entries,previous); try ensureCurrent(); return entries }
            catch PorchError.api(let code, _, _) where code == "REVISION_CHANGED" && attempt < 2 { continue }
        }
        throw PorchError.message("Your emoji collection changed. Reload it and try again.")
    }
}
@MainActor extension AppModel {
    func readEmojiLibrary(session: ReactionSession) async throws -> EmojiLibrarySnapshot {
        try session.require(self)
        let response = try await api.social("/emoji-library")
        try session.require(self)
        let envelope = response["envelope"], revision = try EmojiLibrarySnapshot.revision(response)
        if envelope == .null { return EmojiLibrarySnapshot(revision: revision, envelope: .null, entries: []) }
        let context = envelope["context"]
        guard context["id"].string == session.memberID, context["authorId"].string == session.memberID,
              context["kind"].string == "profile", context["audience"].string == "only_me", context["parentId"] == .null,
              context["groupId"] == .null, context["expiresAt"] == .null, context["revision"] == .number(Double(revision)),
              !envelope["recipients"].array.isEmpty, envelope["recipients"].array.allSatisfy({ $0["memberId"].string == session.memberID }) else { throw PorchError.message("The emoji collection has invalid sharing information.") }
        let payload = try await vault.open(envelope)
        try session.require(self)
        return EmojiLibrarySnapshot(revision: revision, envelope: envelope, entries: try EmojiLibraryPayload.parse(payload))
    }
    func writeEmojiLibrary(_ entries: [ReactionValue], replacing previous: EmojiLibrarySnapshot, session: ReactionSession) async throws {
        try session.require(self, write: true)
        guard let member, previous.revision < Int.max else { throw PorchError.message("The emoji collection is unavailable.") }
        let payload = try EmojiLibraryPayload.encode(entries)
        let original: JSON = .object(["id": .string(member.id), "kind": .string("profile"), "createdAt": previous.envelope["context"]["createdAt"] == .null ? .string(PorchDate.string()) : previous.envelope["context"]["createdAt"], "revision": .number(Double(previous.revision + 1))])
        let envelope = try await vault.seal(payload, member: member, kind: "profile", audience: "only_me", id: member.id, original: original)
        try session.require(self, write: true)
        // Await the submitted write. Unknown outcomes are not automatically
        // retried; a later explicit action rereads the collection first.
        _ = try await api.social("/emoji-library", method: "PUT", body: .object(["envelope": envelope]))
    }
    func mergeEmojiLibrary(_ incoming: [ReactionValue], session: ReactionSession) async throws -> [ReactionValue] {
        try await EmojiLibraryUpdate.merge(incoming,read:{ try await self.readEmojiLibrary(session:session) },write:{ entries,previous in try await self.writeEmojiLibrary(entries,replacing:previous,session:session) },ensureCurrent:{ try session.require(self) })
    }
}
