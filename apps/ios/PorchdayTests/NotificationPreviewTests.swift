import XCTest
import Porchcrypto
import ImageIO
import CoreGraphics
@testable import Porchday

final class NotificationPreviewTests: XCTestCase {
    func testBrowserCiphertextAndSignatureDecryptOnApple() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "notification-preview-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let response = try XCTUnwrap(fixture["response"] as? [String: Any])
        let identity = try XCTUnwrap(response["identity"] as? [String: Any])
        let secret = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(fixture["secret"] as? String)))
        let context = response["context"] as! [String: Any]
        let publicKey = (response["author_key"] as! [String: Any])["public_key"] as! String
        var error: NSError?
        let fingerprint = PorchcryptoPublicFingerprint(publicKey, &error)
        XCTAssertNil(error)
        let pins = [(context["authorId"] as! String) + ":" + (context["authorDeviceId"] as! String): fingerprint]
        let key = NotificationPreviewKey.Record(memberId: identity["memberId"] as! String, deviceId: identity["deviceId"] as! String, keyId: identity["keyId"] as! String, secret: secret, pins: pins)
        let content = try NotificationPreviewCrypto.decrypt(JSONSerialization.data(withJSONObject: response), key: key)
        XCTAssertEqual(content.text, "Test-only caption: garden 🌻 / café")
        XCTAssertNil(content.image)
        XCTAssertTrue(content.path.hasPrefix("/post/"))
        let wrong = NotificationPreviewKey.Record(memberId: UUID().uuidString, deviceId: key.deviceId, keyId: key.keyId, secret: secret, pins: pins)
        XCTAssertThrowsError(try NotificationPreviewCrypto.decrypt(JSONSerialization.data(withJSONObject: response), key: wrong))
        var altered = response
        var signed = altered["signed"] as! [String: Any]
        var statement = signed["statement"] as! [String: Any]
        statement["ciphertext"] = "AAAA"; signed["statement"] = statement; altered["signed"] = signed
        XCTAssertThrowsError(try NotificationPreviewCrypto.decrypt(JSONSerialization.data(withJSONObject: altered), key: key))
    }
    func testAttachmentFileSurvivesUntilNotificationHandoff() throws {
        let pixels = Data([255, 0, 0, 255])
        let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
        let image = try XCTUnwrap(CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let attachment = try NotificationPreviewAttachment.create(data as Data)
        defer { try? FileManager.default.removeItem(at: attachment.url.deletingLastPathComponent()) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: attachment.url.path))
        XCTAssertEqual(try Data(contentsOf: attachment.url), data as Data)
    }
    func testOnlyAllowlistedNotificationRoutesOpen() {
        let id = UUID().uuidString.lowercased()
        XCTAssertEqual(NativePushRouting.path(destination: "/post/" + id), "/post/" + id)
        XCTAssertEqual(NativePushRouting.path(destination: "/?photo=" + id), "/?photo=" + id)
        for value in ["https://evil.test", "//evil.test", "/post/../settings", "/?photo=" + id + "&next=x"] {
            XCTAssertEqual(NativePushRouting.path(destination: value), "/notifications")
        }
    }
}
