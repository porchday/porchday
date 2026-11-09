import Foundation
import UserNotifications
import OSLog

/// Notification callbacks can arrive off the main thread, before the shell exists.
/// Keep the delegate bridge synchronous and acknowledge exactly once after queuing
/// the destination. Never wait for networking, WebKit, or account/key initialization.
enum NativePushRouting {
    private static let logger = Logger(subsystem: "org.porchday.app", category: "NotificationRouting")
    static func receive(destination: String?, action: String, completion: @escaping @Sendable () -> Void) {
        guard action == UNNotificationDefaultActionIdentifier else { completion(); return }
        let feed = destination == "feed"
        logger.notice("Notification tap received")
        Task { @MainActor in
            defer { completion() }
            WebShellPush.shared.destination = feed ? "/" : "/notifications"
            NotificationCenter.default.post(name: Notification.Name("PorchdayPushDestination"), object: feed ? "feed" : "notifications")
            #if DEBUG
            // The production shell does not initialize the retired native UI on a tap.
            if ProcessInfo.processInfo.arguments.contains("--legacy-native-ui-testing") {
                if feed { NativeNotifications.shared.showFeed = true }
                else { NativeNotifications.shared.showInbox = true }
            }
            #endif
            logger.notice("Notification destination queued")
        }
    }
}
