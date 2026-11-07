import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor final class NativeNotifications: ObservableObject {
    static let shared = NativeNotifications()
    @Published private(set) var available = false
    @Published private(set) var enabled = false
    @Published private(set) var busy = false
    @Published private(set) var message = "In-app notifications are always available."
    @Published var showInbox = false
    @Published var showFeed = false
    private weak var model: AppModel?
    private var registeringMember: String?
    private var environment: String? {
        guard Bundle.main.object(forInfoDictionaryKey: "PorchdayPushEnabled") as? String == "YES" else { return nil }
        switch Bundle.main.object(forInfoDictionaryKey: "PorchdayAPNsEnvironment") as? String {
        case "development": return "sandbox"
        case "production": return "production"
        default: return nil
        }
    }
    private func choice(_ member: String) -> String { "push-opt-in:" + member }
    private func subscription(_ member: String) -> String { "push-subscription:" + member }
    func refresh(model: AppModel) async {
        self.model = model
        guard let member = model.member, member.raw["status"].string != "suspended" else { available = false; enabled = false; return }
        let config = try? await model.api.social("/native-push/config")
        available = environment != nil && config?["enabled"].boolean == true
        guard available else { message = "Push notifications will be available in a signed device build when delivery is configured. In-app updates remain available."; return }
        let authorized = await Self.permissionGranted()
        enabled = UserDefaults.standard.bool(forKey: choice(member.id)) && authorized
        if enabled {
            registeringMember = member.id
            ApplePlatform.registerPush()
        } else { message = "Notify this device about every new feed post and photo. Notification previews never include private posts or names." }
    }
    private nonisolated static func permissionGranted() async -> Bool {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus == .authorized)
            }
        }
    }
    /// Only the member's explicit Enable action may request OS permission.
    func enable() async {
        guard available, let model, let member = model.member else { return }
        busy = true; defer { busy = false }
        do {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else {
                message = "Notifications are disabled in device Settings. You can keep using in-app updates."; return
            }
            UserDefaults.standard.set(true, forKey: choice(member.id))
            registeringMember = member.id
            message = "Connecting this device for private notification previews…"
            ApplePlatform.registerPush()
        } catch { message = "Notification permission could not be checked. Please try again." }
    }
    func received(token: Data) async {
        guard let model, let member = model.member, member.id == registeringMember, let environment,
              UserDefaults.standard.bool(forKey: choice(member.id)) else { return }
        // Request a fresh token from APNs on each launch; never persist its bytes.
        let encoded = token.map { String(format: "%02x", $0) }.joined()
        do {
            let result = try await model.api.social("/native-push/subscriptions", method: "POST", body: .object(["token": .string(encoded), "environment": .string(environment)]))
            guard model.member?.id == member.id, let id = result["id"].string else { throw PorchError.message("Notification enrollment was interrupted.") }
            UserDefaults.standard.set(id, forKey: subscription(member.id))
            enabled = true; message = "This device receives notifications for new feed posts and photos. Private content stays inside Porchday."
        } catch { enabled = false; message = "Notification enrollment did not finish. Try Enable again." }
    }
    func registrationFailed() { enabled = false; message = "Push registration is unavailable. Check network access and this build's Apple signing capabilities, then try again." }
    func disable() async {
        guard let model, let member = model.member else { return }
        busy = true; defer { busy = false }
        do {
            if let id = UserDefaults.standard.string(forKey: subscription(member.id)) {
                _ = try await model.api.social("/native-push/subscriptions/" + id, method: "DELETE")
            }
            clearLocal(member: member.id)
            message = "Push is off on this device. In-app notifications remain available."
        } catch { message = "The server could not confirm removal. Try again to finish turning push off." }
    }
    func signOut(model: AppModel) async {
        guard let member = model.member else { return }
        if let id = UserDefaults.standard.string(forKey: subscription(member.id)) {
            _ = try? await model.api.social("/native-push/subscriptions/" + id, method: "DELETE")
        }
        clearLocal(member: member.id)
    }
    private func clearLocal(member: String) {
        UserDefaults.standard.removeObject(forKey: choice(member)); UserDefaults.standard.removeObject(forKey: subscription(member))
        ApplePlatform.unregisterPush()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        registeringMember = nil; enabled = false; showInbox = false; showFeed = false; FeedReadState.badge(0)
    }
}

#if os(iOS)
@MainActor final class PorchdayAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await NativeNotifications.shared.received(token: deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NativeNotifications.shared.registrationFailed()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let feed = response.notification.request.content.userInfo["destination"] as? String == "feed"
        await MainActor.run { if feed { NativeNotifications.shared.showFeed = true } else { NativeNotifications.shared.showInbox = true } }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // Avoid another banner while the member is already using the app.
        await MainActor.run { NotificationCenter.default.post(name: Notification.Name("PorchdayPushReceived"), object: nil) }
        return []
    }
}
#else
@MainActor final class PorchdayAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { UNUserNotificationCenter.current().delegate = self }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { await NativeNotifications.shared.received(token: deviceToken) } }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { NativeNotifications.shared.registrationFailed() }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async { let feed = response.notification.request.content.userInfo["destination"] as? String == "feed"
        await MainActor.run { if feed { NativeNotifications.shared.showFeed = true } else { NativeNotifications.shared.showInbox = true } } }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { await MainActor.run { NotificationCenter.default.post(name: Notification.Name("PorchdayPushReceived"), object: nil) }; return [] }
}
#endif

struct NativeNotificationsSettings: View {
    @ObservedObject private var notifications = NativeNotifications.shared
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(notifications.message).font(.footnote)
            if notifications.available {
                Button(notifications.enabled ? "Turn off push on this device" : "Enable push on this device") {
                    Task { if notifications.enabled { await notifications.disable() } else { await notifications.enable() } }
                }.disabled(notifications.busy)
            }
        }.task { await notifications.refresh(model: model) }
    }
}
