import XCTest
@testable import Porchday
final class FeedReadTests: XCTestCase {
    func testViewportVisibilityIncludesTallCardsButNotPrefetch() {
        let viewport = CGRect(x: 0, y: 100, width: 400, height: 700)
        XCTAssertTrue(FeedVisibility.qualifies(frame: CGRect(x: 0, y: 200, width: 400, height: 2000), viewport: viewport))
        XCTAssertFalse(FeedVisibility.qualifies(frame: CGRect(x: 0, y: 700, width: 400, height: 2000), viewport: viewport))
        XCTAssertFalse(FeedVisibility.qualifies(frame: CGRect(x: 500, y: 200, width: 400, height: 200), viewport: viewport))
        XCTAssertFalse(FeedVisibility.qualifies(frame: .zero, viewport: viewport))
        XCTAssertFalse(FeedVisibility.qualifies(frame: viewport, viewport: .zero))
    }
    func testTypedReadIdentityAndFreshUnreadReads() {
        let id = UUID().uuidString.lowercased()
        XCTAssertNotEqual(FeedReadItem(kind: "post", id: id), FeedReadItem(kind: "photo", id: id))
        XCTAssertEqual(FeedReadItem(kind: "post", id: id).json["kind"].string, "post")
        XCTAssertFalse(NativeReadCache.permits("/api/v1/feed/unread"))
    }
}
