import XCTest
#if canImport(PorchdayMac)
@testable import PorchdayMac
#else
@testable import Porchday
#endif

@MainActor final class NativeReadCacheTests: XCTestCase {
    func testWarmReadsAndConcurrentReadersUseOneRequest() async throws {
        let cache = NativeReadCache(), origin = ReadOrigin()
        let first = Task { try await cache.read("feed") { try await origin.read() } }
        await origin.waitForStart()
        let second = Task { try await cache.read("feed") { try await origin.read() } }
        await Task.yield()
        await origin.release()
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a, b)
        for _ in 0..<25 { _ = try await cache.read("feed") { try await origin.read() } }
        let count = await origin.count
        XCTAssertEqual(count, 1, "25 warm tab returns and concurrent readers must not reload")
    }
    func testInvalidationRejectsLateResponseAndAllowsFreshRead() async throws {
        let cache = NativeReadCache(), origin = ReadOrigin()
        let old = Task { try await cache.read("feed") { try await origin.read() } }
        await origin.waitForStart()
        await cache.invalidate()
        let fresh = try await cache.read("feed") { Data("fresh account".utf8) }
        await origin.release()
        do { _ = try await old.value; XCTFail("Old session response escaped invalidation") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        let retained = try await cache.read("feed") { XCTFail("Late response removed fresh cache"); return Data() }
        XCTAssertEqual(retained, fresh)
    }
    func testExpiryAndFailuresAreNotCached() async throws {
        let cache = NativeReadCache(), now = Date()
        let a = try await cache.read("feed", now: now) { Data([1]) }
        let b = try await cache.read("feed", now: now.addingTimeInterval(21)) { Data([2]) }
        XCTAssertNotEqual(a, b)
        do { _ = try await cache.read("failure") { throw URLError(.notConnectedToInternet) }; XCTFail("Expected failure") } catch {}
        let recovered = try await cache.read("failure") { Data([3]) }
        XCTAssertEqual(recovered, Data([3]))
    }
    func testMemoryBudgetLRUAndContentDeadline() {
        var cache = NativeMemoryCache<String>(budget: 6, limit: 2)
        let now = Date(), future = now.addingTimeInterval(30)
        cache.insert("a", for: "a", cost: 3, expires: future)
        cache.insert("b", for: "b", cost: 3, expires: future)
        XCTAssertEqual(cache.value(for: "a"), "a")
        cache.insert("c", for: "c", cost: 3, expires: future)
        XCTAssertNil(cache.value(for: "b")); XCTAssertEqual(cache.cost, 6)
        cache.insert("oversize", for: "large", cost: 7, expires: future)
        XCTAssertNil(cache.value(for: "large")); XCTAssertEqual(cache.cost, 6)
        XCTAssertNil(cache.value(for: "a", now: future)); XCTAssertEqual(cache.cost, 3)
        cache.clear(); XCTAssertEqual(cache.cost, 0)
    }
    func testOnlyPresentationReadsAreEligible() {
        let id = UUID().uuidString.lowercased()
        for path in ["/api/v1/photo-feed?content=everything", "/api/v1/albums", "/api/v1/connections", "/api/v1/media/\(id)/bytes", "/api/v1/devices/\(id)"] { XCTAssertTrue(NativeReadCache.permits(path), path) }
        for path in ["/api/auth/get-session", "/api/v1/me?bootstrap=1", "/api/v1/keys/backup", "/api/v1/audiences?audience=connections", "/api/v1/posts/\(id)/audience-refresh", "/api/v1/albums/\(id)/audience", "/api/v1/videos/\(id)/access", "/api/v1/videos/\(id)/chunks/0", "/api/v1/exports/\(id)"] { XCTAssertFalse(NativeReadCache.permits(path), path) }
    }
}

private actor ReadOrigin {
    private(set) var count = 0
    private var continuation: CheckedContinuation<Data, Error>?
    private var observer: CheckedContinuation<Void, Never>?
    func read() async throws -> Data {
        count += 1
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; observer?.resume(); observer = nil
        }
    }
    func waitForStart() async {
        if continuation != nil { return }
        await withCheckedContinuation { observer = $0 }
    }
    func release() { continuation?.resume(returning: Data([1,2,3])); continuation = nil }
}
