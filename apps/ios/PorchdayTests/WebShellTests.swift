import XCTest
import WebKit
@testable import Porchday

final class WebShellTests: XCTestCase {
    func testOnlyExactHTTPSOriginIsPrivileged() {
        for url in ["https://porchday.org/", "https://porchday.org/albums?view=all#photo"] { XCTAssertTrue(WebShellPolicy.trusted(URL(string: url))) }
        for url in ["http://porchday.org", "https://porchday.org.evil.example/", "https://porchday.org:8443", "https://someone@porchday.org/", "file:///tmp/test", "javascript:alert(1)", "https://porchday.com"] { XCTAssertFalse(WebShellPolicy.trusted(URL(string: url))) }
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
