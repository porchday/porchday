import XCTest
@testable import Porchday

final class NativePerformanceTests: XCTestCase {
    private let id = "00000000-0000-4000-8000-000000000001"

    func testCriticalOperationsHaveFixedLabels() {
        let cases: [(String, String, NativeRequestOperation)] = [
            ("/api/v1/me?bootstrap=1", "GET", .bootstrap),
            ("/api/v1/feed?cursor=private", "GET", .feed),
            ("/api/v1/groups/\(id)/feed", "GET", .feed),
            ("/api/v1/posts/\(id)", "GET", .postRead),
            ("/api/v1/posts", "POST", .postCreate),
            ("/api/v1/posts/\(id)", "PUT", .postEdit),
            ("/api/v1/posts/\(id)/reactions/private-tag", "PUT", .reactionWrite),
            ("/api/v1/comments/\(id)/reactions/private-tag", "DELETE", .reactionWrite),
            ("/api/v1/media/\(id)", "GET", .mediaRead),
            ("/api/auth/sign-out", "POST", .logoutRequest),
        ]
        for (path, method, expected) in cases {
            XCTAssertEqual(NativeRequestOperation.classify(path: path, method: method), expected)
        }
    }

    func testFallbackNeverIncludesPrivatePathOrQuery() {
        for path in ["", "?secret", "/api/v1/me", "/api/v1/me?bootstrap=0", "/api/v1/posts/audience-refresh", "/api/v1/profiles/private-member?token=secret", "/api/v1/posts/\(id)/comments"] {
            XCTAssertEqual(NativeRequestOperation.classify(path: path, method: "GET"), .otherRead)
        }
        XCTAssertEqual(NativeRequestOperation.classify(path: "/api/auth/sign-in/email", method: "POST"), .otherWrite)
        XCTAssertEqual(NativeRequestOperation.classify(path: "/api/auth/sign-out", method: "GET"), .otherRead)
    }

    func testConcurrentIntervalsHaveIndependentLifetimes() {
        let first = NativePerformance.begin(.feed)
        let second = NativePerformance.begin(.postRead)
        NativePerformance.end(second, status: 503, completed: false)
        NativePerformance.end(first, status: 200, completed: true)
        NativePerformance.end(NativePerformance.begin(.otherRead), status: 0, completed: false)
    }
}
