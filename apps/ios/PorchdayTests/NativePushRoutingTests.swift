import XCTest
import UserNotifications
@testable import Porchday

final class NativePushRoutingTests: XCTestCase {
    @MainActor func testBackgroundCallbackRetainsDestinationWithoutMountedShell() async {
        WebShellPush.shared.destination = nil
        let done = expectation(description: "Notification acknowledged")
        done.assertForOverFulfill = true
        await Task.detached {
            NativePushRouting.receive(destination: "feed", action: UNNotificationDefaultActionIdentifier) { done.fulfill() }
        }.value
        await fulfillment(of: [done], timeout: 3)
        XCTAssertEqual(WebShellPush.shared.destination, "/")
        WebShellPush.shared.destination = nil
    }
    @MainActor func testDismissalDoesNotNavigateAndUnknownPayloadUsesInbox() async {
        WebShellPush.shared.destination = "/"
        let dismissed = expectation(description: "Dismissal acknowledged")
        NativePushRouting.receive(destination: "feed", action: UNNotificationDismissActionIdentifier) { dismissed.fulfill() }
        await fulfillment(of: [dismissed], timeout: 3)
        XCTAssertEqual(WebShellPush.shared.destination, "/")
        let opened = expectation(description: "Unknown payload acknowledged")
        NativePushRouting.receive(destination: "https://untrusted.invalid", action: UNNotificationDefaultActionIdentifier) { opened.fulfill() }
        await fulfillment(of: [opened], timeout: 3)
        XCTAssertEqual(WebShellPush.shared.destination, "/notifications")
        WebShellPush.shared.destination = nil
    }
}
