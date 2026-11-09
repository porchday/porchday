import Foundation
import Security
import CryptoKit

/// Notification-only P256 keys; never reads the account vault or recovery material.
enum NotificationPreviewKey {
    struct Record: Codable {
        let memberId: String, deviceId: String, keyId: String
        let secret: Data
        var pins: [String: String] = [:]
        var key: P256.KeyAgreement.PrivateKey { get throws { try .init(rawRepresentation: secret) } }
        var publicKey: String { get throws { try key.publicKey.x963Representation.base64EncodedString() } }
    }
    enum Failure: Error { case unavailable }
    private static var query: [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.porchday.notification-preview.v1",
            kSecAttrAccount as String: "current"]
        if let group = Bundle.main.object(forInfoDictionaryKey: "PorchdayNotificationKeychainGroup") as? String, !group.isEmpty, !group.contains("$(") {
            q[kSecAttrAccessGroup as String] = group
        }
        #if os(macOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        return q
    }
    static func read() throws -> Record? {
        var q = query; q[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw Failure.unavailable }
        return try JSONDecoder().decode(Record.self, from: data)
    }
    static func current(member: String, device: String, pins: [String: String]) throws -> Record {
        guard UUID(uuidString: member) != nil, UUID(uuidString: device) != nil else { throw Failure.unavailable }
        guard pins.count <= 10000, pins.allSatisfy({ $0.key.range(of: "^[a-fA-F0-9-]{36}:[a-fA-F0-9-]{36}$", options: .regularExpression) != nil && $0.value.range(of: "^[a-fA-F0-9]{40,64}$", options: .regularExpression) != nil }) else { throw Failure.unavailable }
        if var old = try read(), old.memberId == member, old.deviceId == device {
            old.pins = pins
            guard SecItemUpdate(query as CFDictionary, [kSecValueData as String: try JSONEncoder().encode(old)] as CFDictionary) == errSecSuccess else { throw Failure.unavailable }
            return old
        }
        try clear()
        let record = Record(memberId: member, deviceId: device, keyId: UUID().uuidString.lowercased(), secret: P256.KeyAgreement.PrivateKey().rawRepresentation, pins: pins)
        var q = query; q[kSecValueData as String] = try JSONEncoder().encode(record)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw Failure.unavailable }
        return record
    }
    static func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unavailable }
    }
}
