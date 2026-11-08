import XCTest
import WebKit
#if os(macOS)
import ImageIO
import UniformTypeIdentifiers
#endif
@testable import Porchday

final class WebShellTests: XCTestCase {
    #if os(macOS)
    func testSharedTIFFBecomesJPEGWithOriginalDate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("source.tiff")
        let context = try XCTUnwrap(CGContext(data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let pixels = try XCTUnwrap(context.makeImage())
        let writer = try XCTUnwrap(CGImageDestinationCreateWithURL(input as CFURL, UTType.tiff.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(writer, pixels, [kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2017:06:13 23:15:00"]] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(writer))
        let item = try SharedMediaInbox.copyMedia(input, type: UTType.tiff.identifier, suggestedName: "old-photo", into: root)
        XCTAssertEqual(item.type, "image/jpeg"); XCTAssertEqual(item.name, "old-photo.jpg")
        let decoded = try XCTUnwrap(CGImageSourceCreateWithURL(root.appendingPathComponent(item.id) as CFURL, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [String: Any])
        let exif = try XCTUnwrap(properties[kCGImagePropertyExifDictionary as String] as? [String: Any])
        XCTAssertEqual(exif[kCGImagePropertyExifDateTimeOriginal as String] as? String, "2017:06:13 23:15:00")
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
    }
    func testSharedFileIdentifiersCannotEscapeInbox() {
        XCTAssertTrue(SharedMediaInbox.validID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"))
        for value in ["../secret", "/tmp/photo.jpg", "", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"] { XCTAssertFalse(SharedMediaInbox.validID(value)) }
    }
    #endif
    func testOnlyExactHTTPSOriginIsPrivileged() {
        for url in ["https://porchday.org/", "https://porchday.org/albums?view=all#photo"] { XCTAssertTrue(WebShellPolicy.trusted(URL(string: url))) }
        for url in ["http://porchday.org", "https://porchday.org.evil.example/", "https://porchday.org:8443", "https://someone@porchday.org/", "file:///tmp/test", "javascript:alert(1)", "https://porchday.com"] { XCTAssertFalse(WebShellPolicy.trusted(URL(string: url))) }
    }
    func testExportNamesCannotEscapeTheTemporaryDirectory() {
        XCTAssertEqual(WebShellPolicy.exportName("../../photo.jpg"), "photo.jpg")
        XCTAssertEqual(WebShellPolicy.exportName(".."), "Porchday export")
        XCTAssertEqual(WebShellPolicy.exportName("bad\nname"), "Porchday export")
    }
    func testDownloadAndBadgeInputBoundaries() {
        XCTAssertTrue(WebShellPolicy.downloadable(URL(string: "blob:https://porchday.org/123")))
        XCTAssertFalse(WebShellPolicy.downloadable(URL(string: "blob:https://porchday.org.evil.example/123")))
        XCTAssertFalse(WebShellPolicy.downloadable(URL(string: "file:///tmp/private")))
        XCTAssertNil(WebShellPolicy.badge(true)); XCTAssertNil(WebShellPolicy.badge(-1)); XCTAssertNil(WebShellPolicy.badge(2.5)); XCTAssertNil(WebShellPolicy.badge("1")); XCTAssertNil(WebShellPolicy.badge(1_000_001))
        XCTAssertEqual(WebShellPolicy.badge(0), 0); XCTAssertEqual(WebShellPolicy.badge(123), 123)
    }
    @MainActor func testForegroundAndSwiftUIUpdatesRetainWebView() {
        let store = WebShellStore(), original = store.webView
        store.setActive(false); store.setActive(true)
        XCTAssertTrue(store.webView === original)
        XCTAssertTrue(store.webView.configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(store.webView.allowsBackForwardNavigationGestures)
        XCTAssertNil(store.failure)
        store.webView.stopLoading()
    }
}
