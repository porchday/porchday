import SwiftUI
import UserNotifications
import UIKit

@MainActor final class NativeNotifications: ObservableObject {
    static let shared = NativeNotifications()
    @Published private(set) var available = false
    @Published private(set) var enabled = false
    @Published private(set) var busy = false
    @Published private(set) var message = "In-app notifications are always available."
    @Published var showInbox = false
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
        guard available else { message = "Push notifications will be available in a signed iPhone build when delivery is configured. In-app updates remain available."; return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        enabled = UserDefaults.standard.bool(forKey: choice(member.id)) && settings.authorizationStatus == .authorized
        if enabled {
            registeringMember = member.id
            UIApplication.shared.registerForRemoteNotifications()
        } else { message = "Choose whether this iPhone receives generic updates. Notification previews never include private posts or names." }
    }
    /// Only the member's explicit Enable action may request OS permission.
    func enable() async {
        guard available, let model, let member = model.member else { return }
        busy = true; defer { busy = false }
        do {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else {
                message = "Notifications are disabled in iPhone Settings. You can keep using in-app updates."; return
            }
            UserDefaults.standard.set(true, forKey: choice(member.id))
            registeringMember = member.id
            message = "Connecting this iPhone for private notification previews…"
            UIApplication.shared.registerForRemoteNotifications()
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
            enabled = true; message = "This iPhone receives generic updates. Private content stays inside Porchday."
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
            message = "Push is off on this iPhone. In-app notifications remain available."
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
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        registeringMember = nil; enabled = false; showInbox = false
    }
}

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
        await MainActor.run { NativeNotifications.shared.showInbox = true }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // Avoid another banner while the member is already using the app.
        []
    }
}

struct NativeNotificationsSettings: View {
    @ObservedObject private var notifications = NativeNotifications.shared
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(notifications.message).font(.footnote)
            if notifications.available {
                Button(notifications.enabled ? "Turn off push on this iPhone" : "Enable push on this iPhone") {
                    Task { if notifications.enabled { await notifications.disable() } else { await notifications.enable() } }
                }.disabled(notifications.busy)
            }
        }.task { await notifications.refresh(model: model) }
    }
}
