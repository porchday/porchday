import Foundation
import Combine
import Porchcrypto

@MainActor final class CryptoVault: ObservableObject {
    @Published var device: Device?
    @Published var devices: [Device] = []
    @Published var recoveryNote = ""
    private var readOnly = false
    private var sessions: [String: PorchcryptoSession] = [:]
    private var pending: (device: JSON, recovery: JSON, id: String)?
    private let api = API.shared
    var unlocked: Bool { device != nil }
    static func randomSecret() throws -> String { var error: NSError?; let value = PorchcryptoNewSecret(&error); if let error { throw error }; return value }
    private func generate(member: String, id: String, secret: String) throws -> JSON {
        var error: NSError?; let result = PorchcryptoGenerateDeviceKeys(member, id, secret, &error); if let error { throw error }; return try .parse(result)
    }
    private func recover(_ entry: JSON, secret: String) throws -> PorchcryptoSession {
        var error: NSError?; let result = PorchcryptoNewSession(entry["encrypted_private_key"].string, secret, entry["fingerprint"].string, &error)
        if let error { throw error }; guard let result else { throw PorchError.message("The recovery secret did not unlock this device.") }; return result
    }
    private func backupEntry(_ keys: JSON, id: String? = nil) -> JSON {
        var value: [String: JSON] = ["public_key": keys["publicKey"], "fingerprint": keys["fingerprint"], "encrypted_private_key": keys["encryptedPrivateKey"]]
        if let id { value["id"] = .string(id) }; return .object(value)
    }
    func load(member: Member) async throws {
        let result = try await api.social("/devices"); devices = try result["items"].array.map(Device.init)
        readOnly = member.raw["status"].string == "suspended"
        if let current = device, devices.contains(where: { $0.id == current.id && $0.fingerprint == current.fingerprint && !$0.revoked }) { return }
        for session in sessions.values { session.close() }; sessions = [:]; device = nil
        guard let data = try SecureStore.read("device:\(member.id)"), let saved = try? JSONDecoder().decode(JSON.self, from: data), let activeID = saved["active"].string, let active = devices.first(where: { $0.id == activeID && !$0.revoked }) else { return }
        for value in saved["keys"].array {
            guard let fp = value["fingerprint"].string else { continue }; var error: NSError?
            let session = PorchcryptoSessionFromKeychain(value["armor"].string, fp, &error)
            if let error { throw error }; if let session { sessions[fp] = session }
        }
        if sessions[active.fingerprint] != nil { device = active }
    }
    func prepareInitial(member: Member) throws {
        let secret = try Self.randomSecret(), id = UUID().uuidString.lowercased()
        pending = (try generate(member: member.id, id: id, secret: secret), try generate(member: member.id, id: "recovery", secret: secret), id)
        recoveryNote = secret
    }
    func finishInitial(member: Member) async throws {
        guard let pending, !recoveryNote.isEmpty else { throw PorchError.message("Create your keys first.") }
        let entry = backupEntry(pending.device, id: pending.id), recovery = backupEntry(pending.recovery)
        let backup: JSON = .object(["v": .number(1), "devices": .array([entry]), "recovery": recovery])
        let raw: JSON = .object(["id": .string(pending.id), "member_id": .string(member.id), "public_key": entry["public_key"], "fingerprint": entry["fingerprint"], "name": .string("iPhone"), "authorization": .object(["type": .string("initial")]), "recovery_public_key": recovery["public_key"], "backup": backup])
        _ = try await api.social("/devices", method: "POST", body: raw)
        let active = try Device(raw), session = try recover(entry, secret: recoveryNote)
        sessions[active.fingerprint] = session; device = active; devices = [active]
        try persist(member: member); self.pending = nil; recoveryNote = ""
    }
    func unlock(member: Member, secret: String) async throws {
        let response = try await api.social("/keys/backup"), backup = response["envelope"]
        guard backup["v"].integer == 1, !backup["devices"].array.isEmpty else { throw PorchError.message("No compatible backup exists. Use a trusted device.") }
        var recovered: [String: PorchcryptoSession] = [:]
        do {
            for entry in backup["devices"].array { let session = try recover(entry, secret: secret); recovered[session.fingerprint()] = session }
            if member.raw["status"].string == "suspended" {
                guard let entry = backup["devices"].array.first else { throw PorchError.message("No recovery key is available.") }
                let local = try Device(entry.replacing("member_id", with: .string(member.id)))
                for previous in sessions.values { previous.close() }; sessions = recovered; device = local; readOnly = true
                try persist(member: member); return
            }
            let id = UUID().uuidString.lowercased(), keys = try generate(member: member.id, id: id, secret: secret)
            let entry = backupEntry(keys, id: id), challengeBody: JSON = .object(["id": .string(id), "public_key": entry["public_key"], "fingerprint": entry["fingerprint"]])
            let challenge = try await api.social("/devices/challenge", method: "POST", body: challengeBody)
            let recoverySession = try recover(backup["recovery"], secret: secret); defer { recoverySession.close() }
            let statement: JSON = .object(["v": .number(1), "purpose": .string("porchday-device-authorization"), "memberId": .string(member.id), "authorizingDeviceId": .string("recovery"), "deviceId": .string(id), "fingerprint": entry["fingerprint"], "challenge": challenge["challenge"], "expiresAt": challenge["expires_at"]])
            var error: NSError?; let proof = recoverySession.sign(try statement.serialized(), error: &error); if let error { throw error }
            let updated = backup.replacing("devices", with: .array(backup["devices"].array + [entry]))
            let raw = challengeBody.replacing("member_id", with: .string(member.id)).replacing("name", with: .string("iPhone")).replacing("authorization", with: .object(["type": .string("recovery"), "signed": try .parse(proof)])).replacing("backup", with: updated)
            _ = try await api.social("/devices", method: "POST", body: raw)
            _ = try await api.social("/keys/backup", method: "PUT", body: .object(["envelope": updated]))
            let active = try Device(raw), session = try recover(entry, secret: secret)
            recovered[active.fingerprint] = session; sessions = recovered; device = active; devices.append(active); try persist(member: member)
        } catch { for session in recovered.values { session.close() }; throw error }
    }
    private func persist(member: Member) throws {
        var keys: [JSON] = []
        for (fp, session) in sessions { var error: NSError?; let armor = session.keychainArmor(&error); if let error { throw error }; keys.append(.object(["fingerprint": .string(fp), "armor": .string(armor)])) }
        let value: JSON = .object(["active": .string(device?.id ?? ""), "keys": .array(keys)])
        try SecureStore.write(JSONEncoder().encode(value), account: "device:\(member.id)")
    }
    func clear() { for session in sessions.values { session.close() }; sessions = [:]; device = nil; devices = []; recoveryNote = ""; pending = nil }
    private func verify(_ device: Device) throws {
        var error: NSError?; let actual = PorchcryptoPublicFingerprint(device.publicKey, &error); if let error { throw error }
        guard actual == device.fingerprint else { throw PorchError.message("Device fingerprint mismatch. Sharing has stopped.") }
        let pin = "fingerprint:\(device.memberID):\(device.id)"
        if let known = UserDefaults.standard.string(forKey: pin), known != actual { throw PorchError.message("A person's encryption key changed. Compare fingerprints before sharing.") }
        UserDefaults.standard.set(actual, forKey: pin)
    }
    func audience(_ audience: String, group: String? = nil, post: String? = nil) async throws -> (Int, [Device]) {
        var params = URLComponents(); params.queryItems = post.map { [URLQueryItem(name: "post_id", value: $0)] } ?? [URLQueryItem(name: "audience", value: audience)] + (group.map { [URLQueryItem(name: "group_id", value: $0)] } ?? [])
        let result = try await api.social("/audiences?" + (params.percentEncodedQuery ?? ""))
        let devices = try (result["devices"].array.isEmpty ? result["items"].array : result["devices"].array).map(Device.init)
        for device in devices { try verify(device) }; guard let epoch = result["epoch"].integer else { throw PorchError.message("The sharing audience is unavailable.") }; return (epoch, devices)
    }
    func seal(_ payload: JSON, member: Member, kind: String, audience: String, id: String = UUID().uuidString.lowercased(), group: String? = nil, parent: String? = nil, post: String? = nil, expiry: Date? = nil, original: JSON? = nil) async throws -> JSON {
        guard !readOnly, let device, let session = sessions[device.fingerprint] else { throw PorchError.message("This account can manage its data but cannot publish.") }
        let (epoch, recipients) = try await self.audience(audience, group: group, post: post)
        var context = original?.object ?? ["id": .string(id), "kind": .string(kind), "createdAt": .string(PorchDate.string()), "revision": .number(1)]
        context["authorId"] = .string(member.id); context["authorDeviceId"] = .string(device.id); context["audience"] = .string(audience)
        context["parentId"] = parent.map(JSON.string) ?? .null; context["groupId"] = group.map(JSON.string) ?? .null; context["epoch"] = .number(Double(epoch)); context["expiresAt"] = expiry.map { .string(PorchDate.string($0)) } ?? .null
        var error: NSError?; let encrypted = session.encrypt(try JSON.object(context).serialized(), payloadJSON: try payload.serialized(), recipientsJSON: try JSON.array(recipients.map(\.recipient)).serialized(), error: &error)
        if let error { throw error }; return try .parse(encrypted)
    }
    func open(_ row: JSON) async throws -> JSON {
        let envelope = row["envelope"] == .null ? row : row["envelope"], context = envelope["context"]
        if let id = row["id"].string, id != context["id"].string { throw PorchError.message("Content identity mismatch.") }
        if let author = row["author_id"].string, author != context["authorId"].string { throw PorchError.message("Content author mismatch.") }
        if let deadline = row["effective_expires_at"].string.flatMap(PorchDate.parse), deadline <= Date() { throw PorchError.message("This content has expired.") }
        guard let authorID = context["authorDeviceId"].string else { throw PorchError.message("Missing author identity.") }
        let author = try Device(try await api.social("/devices/" + authorID)); try verify(author)
        guard let session = envelope["recipients"].array.compactMap({ $0["fingerprint"].string }).compactMap({ sessions[$0] }).first else { throw PorchError.message("This content predates your device. Restore your recovery keys or ask the author to share it.") }
        var error: NSError?; let payload = session.decrypt(try envelope.serialized(), expectedContextJSON: try context.serialized(), authorPublicKey: author.publicKey, error: &error)
        if let error { throw error }; return try .parse(payload)
    }
    func item(_ row: JSON) async -> SocialItem { let envelope = row["envelope"]; do { return SocialItem(id: row["id"].string ?? envelope["context"]["id"].string ?? "", raw: row, envelope: envelope, payload: try await open(row), error: nil) } catch { return SocialItem(id: row["id"].string ?? "", raw: row, envelope: envelope, payload: nil, error: error.localizedDescription) } }
    func sign(_ statement: JSON) throws -> JSON { guard !readOnly, let device, let session = sessions[device.fingerprint] else { throw PorchError.message("Device locked.") }; var error: NSError?; let value = session.sign(try statement.serialized(), error: &error); if let error { throw error }; return try .parse(value) }
    static func tag(secret: String, target: String, member: String, emoji: String) throws -> String { var error: NSError?; let tag = PorchcryptoReactionTag(secret, target, member, emoji, &error); if let error { throw error }; return tag }
    static func archive(_ data: Data, secret: String) throws -> Data { var error: NSError?; let value = PorchcryptoEncryptArchive(data, secret, &error); if let error { throw error }; guard let value else { throw PorchError.message("Export encryption failed.") }; return value }
    static func unarchive(_ data: Data, secret: String) throws -> Data { var error: NSError?; let value = PorchcryptoDecryptArchive(data, secret, &error); if let error { throw error }; guard let value else { throw PorchError.message("Archive could not be unlocked.") }; return value }
}
