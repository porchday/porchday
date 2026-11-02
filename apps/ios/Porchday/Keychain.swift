import Foundation
import Security

// Device-only protection keeps sessions/private keys out of backups and user defaults.
enum SecureStore {
    static let service = ServerConfiguration.keychainService
    private static func query(_ account: String? = nil) -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { value[kSecAttrAccount as String] = account }
        #if os(macOS)
        // Match iOS protection classes instead of the legacy file-based Mac keychain.
        value[kSecUseDataProtectionKeychain as String] = true
        #endif
        return value
    }
    static func read(_ account: String) throws -> Data? {
        var q = query(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw PorchError.message("Unlock your device to access Porchday's secure storage.") }
        return result as? Data
    }
    static func write(_ data: Data, account: String) throws {
        let q = query(account)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        // Do not discard the old recovery/session material if an update fails.
        let update = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw PorchError.message("Could not update this device's private keys securely.") }
        var add = q; attributes.forEach { add[$0.key] = $0.value }
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw PorchError.message("Could not save this device's private keys securely.") }
    }
    static func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
    static func clear() { SecItemDelete(query() as CFDictionary) }
}
