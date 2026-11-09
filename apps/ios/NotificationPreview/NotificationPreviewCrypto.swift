import Foundation
import CryptoKit
import Porchcrypto

/// Wire-compatible with packages/crypto/src/notification-preview.ts.
enum NotificationPreviewCrypto {
    enum Failure: Error { case invalid }
    struct Content { let text: String; let image: Data?; let path: String }
    // Context/binding contain only ASCII UUIDs, ISO dates, integers, and fixed strings.
    static func canonical(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func decrypt(_ response: Data, key: NotificationPreviewKey.Record) throws -> Content {
        guard response.count <= 1_000_000,
            let root = try JSONSerialization.jsonObject(with: response) as? [String: Any],
            let signed = root["signed"] as? [String: Any], let context = root["context"] as? [String: Any],
            let author = root["author_key"] as? [String: Any], let publicKey = author["public_key"] as? String,
            let identity = root["identity"] as? [String: Any],
            identity["keyId"] as? String == key.keyId, identity["memberId"] as? String == key.memberId,
            identity["deviceId"] as? String == key.deviceId,
            author["member_id"] as? String == context["authorId"] as? String,
            author["id"] as? String == context["authorDeviceId"] as? String,
            context["purpose"] as? String == "porchday-notification-preview", context["v"] as? Int == 1,
            let id = context["id"] as? String, UUID(uuidString: id) != nil,
            let kind = context["kind"] as? String, ["post", "photo"].contains(kind) else { throw Failure.invalid }
        if let expires = context["expiresAt"] as? String {
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let parsed = formatter.date(from: expires) ?? ISO8601DateFormatter().date(from: expires)
            guard let parsed, parsed > Date() else { throw Failure.invalid }
        } else if !(context["expiresAt"] is NSNull) { throw Failure.invalid }
        var error: NSError?
        let fingerprint = PorchcryptoPublicFingerprint(publicKey, &error)
        if let error { throw error }
        guard let authorID = context["authorId"] as? String, let deviceID = context["authorDeviceId"] as? String,
            key.pins[authorID + ":" + deviceID] == fingerprint else { throw Failure.invalid }
        let verified = PorchcryptoVerifyStatement(String(decoding: try canonical(signed), as: UTF8.self), publicKey, &error)
        if let error { throw error }
        guard let package = try JSONSerialization.jsonObject(with: Data(verified.utf8)) as? [String: Any],
            let signedContext = package["context"] as? [String: Any], try canonical(signedContext) == canonical(context),
            let recipients = package["recipients"] as? [[String: Any]], recipients.count <= 1000,
            let recipient = recipients.first(where: { $0["keyId"] as? String == key.keyId && $0["memberId"] as? String == key.memberId && $0["deviceId"] as? String == key.deviceId }) else { throw Failure.invalid }
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: bytes(recipient, "ephemeral", maximum: 65))
        let secret = try key.key.sharedSecretFromKeyAgreement(with: ephemeral)
        var binding = context; binding["keyId"] = key.keyId; binding["memberId"] = key.memberId; binding["deviceId"] = key.deviceId
        let info = try canonical(binding)
        let wrappingKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(repeating: 0, count: 32), sharedInfo: info, outputByteCount: 32)
        let raw = try open(recipient, key: wrappingKey, aad: info, maximum: 48)
        guard raw.count == 32 else { throw Failure.invalid }
        let plain = try open(package, key: SymmetricKey(data: raw), aad: canonical(context), maximum: 26016)
        guard let content = try JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let text = content["text"] as? String, text.unicodeScalars.count <= 240 else { throw Failure.invalid }
        var image: Data?
        if let value = content["image"] as? String {
            let prefix = "data:image/jpeg;base64,"
            guard value.hasPrefix(prefix), value.utf8.count <= 24000, let decoded = Data(base64Encoded: String(value.dropFirst(prefix.count))) else { throw Failure.invalid }
            image = decoded
        }
        return Content(text: text, image: image, path: kind == "post" ? "/post/\(id)" : "/?photo=\(id)")
    }
    private static func bytes(_ object: [String: Any], _ name: String, maximum: Int) throws -> Data {
        guard let value = object[name] as? String, value.count <= maximum * 2, let data = Data(base64Encoded: value), data.count <= maximum else { throw Failure.invalid }
        return data
    }
    private static func open(_ object: [String: Any], key: SymmetricKey, aad: Data, maximum: Int) throws -> Data {
        let iv = try bytes(object, "iv", maximum: 12), encrypted = try bytes(object, "ciphertext", maximum: maximum)
        guard iv.count == 12, encrypted.count >= 16 else { throw Failure.invalid }
        return try AES.GCM.open(.init(nonce: .init(data: iv), ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16)), using: key, authenticating: aad)
    }
}
