import XCTest
import Porchcrypto
@testable import Porchday

final class SharingAudienceTests: XCTestCase {
    func testAudiencePickerPreservesExistingValuesAndPlacesFriendsAboveFamily() {
        XCTAssertEqual(SharingAudience.allCases.map(\.rawValue), ["connections", "friends", "family", "only_me"])
        XCTAssertEqual(SharingAudience.allCases.map(\.label), ["Friends & family", "Friends only", "Family only", "Only me"])
    }

    func testFriendsOnlyContextEncryptsAndAuthenticatesWithoutChangingConnectionsMeaning() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "openpgp-v1", withExtension: "json"))
        let fixture = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
        let alice = fixture["alice"], bob = fixture["bob"]
        var error: NSError?
        let author = try XCTUnwrap(PorchcryptoNewSession(alice["encryptedPrivateKey"].string, alice["recoverySecret"].string, alice["fingerprint"].string, &error))
        XCTAssertNil(error); defer { author.close() }
        let reader = try XCTUnwrap(PorchcryptoNewSession(bob["encryptedPrivateKey"].string, bob["recoverySecret"].string, bob["fingerprint"].string, &error))
        XCTAssertNil(error); defer { reader.close() }
        let bobRecipient = try XCTUnwrap(fixture["envelope"]["recipients"].array.first { $0["fingerprint"] == bob["fingerprint"] })
        let recipients: JSON = .array([
            .object(["memberId": fixture["envelope"]["context"]["authorId"], "deviceId": fixture["envelope"]["context"]["authorDeviceId"], "publicKey": alice["publicKey"]]),
            .object(["memberId": bobRecipient["memberId"], "deviceId": bobRecipient["deviceId"], "publicKey": bob["publicKey"]])
        ])
        let payload: JSON = .object(["text": .string("Synthetic friends-only post")])
        for audience in [SharingAudience.friends, .connections, .family] {
            let context = fixture["envelope"]["context"].replacing("id", with: .id()).replacing("audience", with: .string(audience.rawValue))
                .replacing("createdAt", with: .string(PorchDate.string())).replacing("expiresAt", with: .null)
            error = nil
            let sealed = author.encrypt(try context.serialized(), payloadJSON: try payload.serialized(), recipientsJSON: try recipients.serialized(), error: &error)
            XCTAssertNil(error)
            let envelope = try JSON.parse(sealed)
            XCTAssertEqual(envelope["context"]["audience"], .string(audience.rawValue))
            let opened = reader.decrypt(sealed, expectedContextJSON: try context.serialized(), authorPublicKey: alice["publicKey"].string, error: &error)
            XCTAssertNil(error); XCTAssertEqual(try JSON.parse(opened), payload)
            let tampered = envelope.replacing("context", with: context.replacing("audience", with: .string("only_me")))
            error = nil
            _ = reader.decrypt(try tampered.serialized(), expectedContextJSON: try tampered["context"].serialized(), authorPublicKey: alice["publicKey"].string, error: &error)
            XCTAssertNotNil(error)
        }
    }
}
