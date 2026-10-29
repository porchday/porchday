import XCTest
@testable import Porchday

@MainActor final class ProgressiveFeedTests: XCTestCase {
    func testPublishesFirstItemBeforeOpeningSecondAndPreservesOrder() async {
        var published: [[Int]] = []
        let completed = await ProgressiveFeed.decode([1, 2, 3], isCurrent: { true }, open: { value in
            if value == 2 { XCTAssertEqual(published, [[10]]) }
            if value == 3 { XCTAssertEqual(published, [[10], [10, 20]]) }
            return value * 10
        }, publish: { published.append($0) })
        XCTAssertTrue(completed)
        XCTAssertEqual(published, [[10], [10, 20], [10, 20, 30]])
    }
    func testAccountOrRequestChangeDuringDecodeDoesNotPublishStaleResult() async {
        var current = true
        var published: [[Int]] = []
        var opened: [Int] = []
        let completed = await ProgressiveFeed.decode([1, 2, 3], isCurrent: { current }, open: { value in
            opened.append(value)
            if value == 2 { current = false }
            return value
        }, publish: { published.append($0) })
        XCTAssertFalse(completed)
        XCTAssertEqual(opened, [1, 2])
        XCTAssertEqual(published, [[1]])
    }
    func testAlreadyInvalidOrEmptyPageDoesNotOpenAnything() async {
        var opened = 0
        let invalid = await ProgressiveFeed.decode([1], isCurrent: { false }, open: { value in opened += 1; return value }, publish: { _ in XCTFail("Stale page published") })
        let empty = await ProgressiveFeed.decode([Int](), isCurrent: { true }, open: { value in opened += 1; return value }, publish: { _ in XCTFail("Empty page published") })
        XCTAssertFalse(invalid)
        XCTAssertTrue(empty)
        XCTAssertEqual(opened, 0)
    }
    func testCancelledTaskNeverPublishes() async {
        let task = Task { @MainActor in
            await ProgressiveFeed.decode([1], isCurrent: { true }, open: { value in
                withUnsafeCurrentTask { $0?.cancel() }
                return value
            }, publish: { _ in XCTFail("Cancelled result published") })
        }
        let completed = await task.value
        XCTAssertFalse(completed)
    }
    func testFirstPostRemainsAvailableWhileLaterDecodeSuspendsAndCancellationDiscardsIt() async {
        let gate = DecodeGate()
        var published: [[Int]] = []
        let task = Task { @MainActor in
            await ProgressiveFeed.decode([1, 2, 3], isCurrent: { true }, open: { value in
                if value == 2 { await gate.wait() }
                return value
            }, publish: { published.append($0) })
        }
        await gate.untilWaiting()
        XCTAssertEqual(published, [[1]])
        task.cancel()
        gate.release()
        let completed = await task.value
        XCTAssertFalse(completed)
        XCTAssertEqual(published, [[1]])
    }

}


@MainActor private final class DecodeGate {
    private var waiting: CheckedContinuation<Void, Never>?
    private var observer: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            waiting = continuation
            observer?.resume()
            observer = nil
        }
    }
    func untilWaiting() async {
        if waiting != nil { return }
        await withCheckedContinuation { observer = $0 }
    }
    func release() { waiting?.resume(); waiting = nil }
}
