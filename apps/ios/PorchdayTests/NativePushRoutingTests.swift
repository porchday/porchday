import XCTest
import UserNotifications
@testable import Porchday

final class NativePushRoutingTests: XCTestCase {
    @MainActor func testBackgroundCallbackRoutesBeforeAcknowledging() async {
        let routed = expectation(description: "Feed destination delivered on main thread")
        let done = expectation(description: "Notification acknowledged")
        routed.assertForOverFulfill = true; done.assertForOverFulfill = true
        let observer = NotificationCenter.default.addObserver(forName: Notification.Name("PorchdayPushDestination"), object: nil, queue: .main) { notice in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(notice.object as? String, "/")
            routed.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        await Task.detached {
            NativePushRouting.receive(destination: "feed", action: UNNotificationDefaultActionIdentifier) { done.fulfill() }
        }.value
        await fulfillment(of: [routed, done], timeout: 3, enforceOrder: true)
    }
    @MainActor func testDismissalDoesNotNavigateAndUnknownPayloadUsesInbox() async {
        let routed = expectation(description: "Unknown payload opens inbox")
        routed.assertForOverFulfill = true
        let observer = NotificationCenter.default.addObserver(forName: Notification.Name("PorchdayPushDestination"), object: nil, queue: .main) { notice in
            XCTAssertEqual(notice.object as? String, "/notifications")
            routed.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        let dismissed = expectation(description: "Dismissal acknowledged")
        NativePushRouting.receive(destination: "feed", action: UNNotificationDismissActionIdentifier) { dismissed.fulfill() }
        await fulfillment(of: [dismissed], timeout: 3)
        let opened = expectation(description: "Unknown payload acknowledged")
        NativePushRouting.receive(destination: "https://untrusted.invalid", action: UNNotificationDefaultActionIdentifier) { opened.fulfill() }
        await fulfillment(of: [routed, opened], timeout: 3, enforceOrder: true)
    }
}
