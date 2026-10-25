import Foundation
import Security
import XCTest
@testable import Porchday

final class SecureStoreTests: XCTestCase {
    func testDeviceOnlyKeychainRoundTrip() throws {
        let account = "synthetic-keychain-test:" + UUID().uuidString
        defer { SecureStore.delete(account) }
        let first = Data("synthetic-keychain-first".utf8)
        let replacement = Data("synthetic-keychain-replacement".utf8)
        XCTAssertNil(try SecureStore.read(account))
        try SecureStore.write(first, account: account)
        XCTAssertEqual(try SecureStore.read(account), first)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SecureStore.service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let attributes = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertNotEqual(attributes[kSecAttrSynchronizable as String] as? Bool, true)

        try SecureStore.write(replacement, account: account)
        XCTAssertEqual(try SecureStore.read(account), replacement)
        SecureStore.delete(account)
        XCTAssertNil(try SecureStore.read(account))
    }
}
