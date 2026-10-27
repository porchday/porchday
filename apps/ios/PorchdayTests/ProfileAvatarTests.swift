import XCTest
import UIKit
@testable import Porchday

@MainActor final class ProfileAvatarTests: XCTestCase {
    func testRepeatedAuthorsShareAnImageAndClearForcesReload() async throws {
        let cache = ProfileAvatarCache(), image = UIImage()
        var calls = 0
        let load: @MainActor @Sendable () async throws -> (UIImage?, Date) = { calls += 1; return (image, .distantFuture) }
        let first = try await cache.image(for: "member:device:author", load: load)
        let second = try await cache.image(for: "member:device:author", load: load)
        XCTAssertTrue(first?.image === second?.image)
        XCTAssertEqual(calls, 1)
        cache.clear()
        _ = try await cache.image(for: "member:device:author", load: load)
        XCTAssertEqual(calls, 2)
    }
    func testDeniedAndExpiredImagesUseFallback() async throws {
        let cache = ProfileAvatarCache()
        do { _ = try await cache.image(for: "denied") { throw CancellationError() }; XCTFail("Expected denied request") } catch {}
        let fallback = try await cache.image(for: "denied") { XCTFail("Do not retry each appearance"); return (UIImage(), .distantFuture) }
        XCTAssertNil(fallback)
        let expired = try await cache.image(for: "expired") { (UIImage(), .distantPast) }
        XCTAssertNil(expired)
    }
    func testClearingDuringDownloadDiscardsLateResult() async throws {
        let cache = ProfileAvatarCache()
        var complete: CheckedContinuation<(UIImage?, Date), Error>?
        let pending = Task { try await cache.image(for: "member") { try await withCheckedThrowingContinuation { complete = $0 } } }
        while complete == nil { await Task.yield() }
        cache.clear()
        complete?.resume(returning: (UIImage(), .distantFuture))
        do { _ = try await pending.value; XCTFail("A cleared image must not return") } catch {}
        let fallback = try await cache.image(for: "member") { (nil, .distantFuture) }
        XCTAssertNil(fallback)
    }
}
