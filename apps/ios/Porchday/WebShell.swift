import SwiftUI
import WebKit
import CoreFoundation
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Keep URL policy independent of WebKit so redirects and bridge frames use the same rule.
enum WebShellPolicy {
    static func exportName(_ suggested: String) -> String {
        let name = (suggested as NSString).lastPathComponent
        return name.isEmpty || name == "." || name == ".." || name.utf8.count > 240 || name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) ? "Porchday export" : name
    }
    static func cleanAbandonedExports() {
        let manager = FileManager.default
        for url in (try? manager.contentsOfDirectory(at: manager.temporaryDirectory, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent.hasPrefix("porchday-shell-") {
            try? manager.removeItem(at: url)
        }
    }
    static func trusted(_ url: URL?, origin: URL = ServerConfiguration.origin) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }
    static func downloadable(_ url: URL?, origin: URL = ServerConfiguration.origin) -> Bool {
        guard let url else { return false }
        return trusted(url, origin: origin) || url.absoluteString.hasPrefix("blob:" + origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/")
    }
    static func external(_ url: URL) -> Bool { ["https", "http", "mailto"].contains(url.scheme ?? "") && url.user == nil && url.password == nil }
    static func badge(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.rounded() == n.doubleValue, n.intValue >= 0, n.intValue <= 1_000_000 else { return nil }
        return n.intValue
    }
}

@MainActor final class WebShellPush {
    static let shared = WebShellPush()
    var destination: String?
    private var reply: ((Any?, String?) -> Void)?
    private var timeout: Task<Void, Never>?
    var environment: String? {
        guard Bundle.main.object(forInfoDictionaryKey: "PorchdayPushEnabled") as? String == "YES" else { return nil }
        switch Bundle.main.object(forInfoDictionaryKey: "PorchdayAPNsEnvironment") as? String {
        case "production": return "production"
        case "development": return "sandbox"
        default: return nil
        }
    }
    func register(prompt: Bool, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard environment != nil else { reply(nil, "Notifications require a signed push-capable build."); return }
        guard self.reply == nil else { reply(nil, "Notification registration is already in progress."); return }
        self.reply = reply
        timeout = Task { try? await Task.sleep(for: .seconds(25)); if !Task.isCancelled { finish(nil, "Notification registration timed out. Try again.") } }
        Task {
            do {
                let center = UNUserNotificationCenter.current()
                let allowed: Bool
                if prompt { allowed = try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
                else { allowed = await center.notificationSettings().authorizationStatus == .authorized }
                guard self.reply != nil else { return }
                guard allowed else { finish(nil, "Allow notifications in system Settings, then try again."); return }
                ApplePlatform.registerPush()
            } catch { finish(nil, "Notification permission could not be checked.") }
        }
    }
    func received(_ token: Data) {
        guard let environment else { return }
        finish(["token": token.map { String(format: "%02x", $0) }.joined(), "environment": environment], nil)
    }
    func failed() { finish(nil, "Apple push registration failed. Please try again.") }
    func clear() {
        finish(nil, "Notification registration was cancelled.")
        try? NotificationPreviewKey.clear()
        ApplePlatform.unregisterPush()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        FeedReadState.badge(0)
    }
    private func finish(_ value: Any?, _ error: String?) {
        timeout?.cancel(); timeout = nil
        let callback = reply; reply = nil; callback?(value, error)
    }
}

@MainActor private final class WeakShellBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var store: WebShellStore?
    init(_ store: WebShellStore) { self.store = store }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let store else { replyHandler(nil, "App window closed."); return }
        store.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}
private final class ShellObservers: @unchecked Sendable {
    var values: [NSObjectProtocol] = []
    deinit { values.forEach { NotificationCenter.default.removeObserver($0) } }
}
@MainActor final class WebShellStore: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, WKDownloadDelegate {
    let webView: WKWebView
    @Published var dialog: ShellDialog?
    @Published var dialogInput = ""
    @Published var failure: String?
    @Published var showPreviousApp = false
    @Published var downloadURL: URL?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private let observers = ShellObservers()
    private var selectedURLs: [URL] = []
    private var pendingDestination: String?
    private var active = true
    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(WeakShellBridge(self), contentWorld: .page, name: "porchday")
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = nil
        #if os(iOS)
        webView.scrollView.keyboardDismissMode = .interactive
        #endif
        observers.values.append(NotificationCenter.default.addObserver(forName: Notification.Name("PorchdayPushReceived"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.event("porchday:native-push") }
        })
        observers.values.append(NotificationCenter.default.addObserver(forName: Notification.Name("PorchdayPushDestination"), object: nil, queue: .main) { [weak self] notice in
            let path = NativePushRouting.path(destination: notice.object as? String)
            Task { @MainActor in self?.navigate(path) }
        })
        webView.load(URLRequest(url: ServerConfiguration.origin))
    }
    func retry() { failure = nil; webView.load(URLRequest(url: WebShellPolicy.trusted(webView.url) ? webView.url! : ServerConfiguration.origin)) }
    func setActive(_ value: Bool) {
        active = value
        guard WebShellPolicy.trusted(webView.url) else { return }
        webView.callAsyncJavaScript("window.porchdayNativeActive = active; window.dispatchEvent(new Event('porchday:native-active'));", arguments: ["active": value], in: nil, in: .page, completionHandler: nil)
    }
    private func event(_ name: String) {
        guard WebShellPolicy.trusted(webView.url) else { return }
        webView.callAsyncJavaScript("window.dispatchEvent(new Event(name));", arguments: ["name": name], in: nil, in: .page, completionHandler: nil)
    }
    func navigate(_ path: String) {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return }
        guard WebShellPolicy.trusted(webView.url), !webView.isLoading else { pendingDestination = path; return }
        WebShellPush.shared.destination = nil
        webView.callAsyncJavaScript("window.porchdayNativeDestination = path; window.dispatchEvent(new Event('porchday:native-navigate'));", arguments: ["path": path], in: nil, in: .page, completionHandler: nil)
    }
    func open(_ url: URL) {
        guard WebShellPolicy.trusted(url) else { return }
        navigate(url.path + (url.query.map { "?" + $0 } ?? "") + (url.fragment.map { "#" + $0 } ?? ""))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let frame = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, WebShellPolicy.trusted(message.frameInfo.request.url), WebShellPolicy.trusted(webView.url), frame.protocol == "https", frame.host == ServerConfiguration.origin.host,
              let body = message.body as? [String: Any], body["version"] as? Int == 1, let command = body["command"] as? String else { replyHandler(nil, "Untrusted native request."); return }
        switch command {
        #if os(macOS)
        case "sharedMediaList":
            do {
                let batches = try SharedMediaInbox.batches()
                let data = try JSONEncoder().encode(batches)
                replyHandler(try JSONSerialization.jsonObject(with: data), nil)
            } catch { replyHandler(nil, "Shared photos and videos could not be read.") }
        case "sharedMediaRead":
            guard let batch = body["batch"] as? String, let item = body["item"] as? String,
                  let offset = body["offset"] as? Int, let count = body["count"] as? Int else { replyHandler(nil, "Invalid shared file request."); return }
            do { replyHandler(try SharedMediaInbox.chunk(batch: batch, item: item, offset: offset, count: count), nil) }
            catch { replyHandler(nil, "This shared file could not be read. Share it again from Photos.") }
        case "sharedMediaRemove":
            guard let batch = body["batch"] as? String else { replyHandler(nil, "Invalid shared file request."); return }
            do { try SharedMediaInbox.remove(batch); replyHandler(true, nil) }
            catch { replyHandler(nil, "Shared files could not be cleared.") }
        #endif
        case "notificationPreviewKey":
            guard let member = body["memberId"] as? String, let device = body["deviceId"] as? String else { replyHandler(nil, "Invalid notification identity."); return }
            do { let key = try NotificationPreviewKey.current(member: member, device: device, pins: body["pins"] as? [String: String] ?? [:]); replyHandler(["keyId": key.keyId, "publicKey": try key.publicKey], nil) }
            catch { replyHandler(nil, "Notification previews are unavailable on this device.") }
        case "clearPreviewKeys":
            do { try NotificationPreviewKey.clear(); replyHandler(true, nil) }
            catch { replyHandler(nil, "Notification preview keys could not be cleared.") }
        case "badge":
            guard let count = WebShellPolicy.badge(body["count"]) else { replyHandler(nil, "Invalid badge count."); return }
            FeedReadState.badge(count); replyHandler(true, nil)
        case "push":
            guard let prompt = body["requestPermission"] as? Bool else { replyHandler(nil, "Invalid permission request."); return }
            WebShellPush.shared.register(prompt: prompt, reply: replyHandler)
        case "clear": WebShellPush.shared.clear(); replyHandler(true, nil)
        case "logout":
            WebShellPush.shared.clear()
            Task {
                var failed = false
                if (try? SecureStore.read("session")) != nil {
                    do { _ = try await API.shared.auth("sign-out") }
                    catch { failed = true }
                }
                await API.shared.clearSession(); SecureStore.clear()
                replyHandler(failed ? nil : true, failed ? "Local keys were cleared, but the previous app session could not confirm sign-out. Revoke it in Settings." : nil)
            }
        default: replyHandler(nil, "Unsupported native operation.")
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure = nil; setActive(active)
        if let path = pendingDestination ?? WebShellPush.shared.destination { pendingDestination = nil; navigate(path) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failure = "Porchday could not load. Check your connection and try again." }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { self.webView(webView, didFailProvisionalNavigation: navigation, withError: error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failure = "Porchday needs to reopen this page. Unsaved changes may need to be entered again." }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload && WebShellPolicy.downloadable(url) { decisionHandler(.download); return }
        if WebShellPolicy.trusted(url) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated && WebShellPolicy.external(url) { openExternal(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(WebShellPolicy.downloadable(response.response.url) ? (response.canShowMIMEType ? .allow : .download) : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { if WebShellPolicy.trusted(url) { open(url) } else if WebShellPolicy.external(url) { openExternal(url) } }
        return nil
    }
    private func openExternal(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, WebShellPolicy.trusted(frame.request.url), dialog == nil else { completionHandler(); return }
        dialog = ShellDialog(message: message, kind: .alert, reply: { _ in completionHandler() })
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, WebShellPolicy.trusted(frame.request.url), dialog == nil else { completionHandler(false); return }
        dialog = ShellDialog(message: message, kind: .confirm, reply: { completionHandler($0 != nil) })
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        guard frame.isMainFrame, WebShellPolicy.trusted(frame.request.url), dialog == nil else { completionHandler(nil); return }
        dialogInput = defaultText ?? ""
        dialog = ShellDialog(message: prompt, kind: .prompt, reply: completionHandler)
    }
    func answerDialog(_ accepted: Bool) { let current = dialog; dialog = nil; current?.reply(accepted ? dialogInput : nil); dialogInput = "" }
    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        guard frame.isMainFrame, WebShellPolicy.trusted(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = false
        panel.begin { [weak self] result in
            guard result == .OK else { completionHandler(nil); return }
            self?.selectedURLs.forEach { $0.stopAccessingSecurityScopedResource() }
            self?.selectedURLs = panel.urls.filter { $0.startAccessingSecurityScopedResource() }
            completionHandler(panel.urls)
        }
    }
    #endif
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        guard WebShellPolicy.downloadable(response.url) else { completionHandler(nil); return }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("porchday-shell-" + UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let url = directory.appendingPathComponent(WebShellPolicy.exportName(suggestedFilename))
            downloads[ObjectIdentifier(download)] = url; completionHandler(url)
        } catch { failure = "The export could not be saved."; completionHandler(nil) }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping @MainActor @Sendable (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(WebShellPolicy.trusted(request.url) ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        #if os(iOS)
        downloadURL = url
        #else
        let panel = NSSavePanel(); panel.nameFieldStringValue = url.lastPathComponent
        panel.begin { [weak self] result in
            defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            guard result == .OK, let target = panel.url else { return }
            do { if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }; try FileManager.default.copyItem(at: url, to: target) }
            catch { self?.failure = "The export could not be saved." }
        }
        #endif
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        failure = "The download did not finish. Please try again."
    }
}

#if os(iOS)
struct SharedWebView: UIViewRepresentable {
    let store: WebShellStore
    func makeUIView(context: Context) -> WKWebView { store.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
struct ShellExportSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#else
struct SharedWebView: NSViewRepresentable {
    let store: WebShellStore
    func makeNSView(context: Context) -> WKWebView { store.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif

struct ShellDialog {
    enum Kind { case alert, confirm, prompt }
    let message: String
    let kind: Kind
    let reply: (String?) -> Void
}
struct WebShellRoot: View {
    @StateObject private var store = WebShellStore()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        SharedWebView(store: store)
            .overlay(alignment: .topTrailing) {
                Menu { Button("Previous app") { store.showPreviousApp = true }; Button("Reload page") { store.retry() } } label: { Image(systemName: "ellipsis.circle").padding(8) }.accessibilityLabel("App help")
            }
            .overlay { if let failure = store.failure { VStack(spacing: 16) { Text(failure); Button("Try again") { store.retry() }; Button("Previous app") { store.showPreviousApp = true } }.padding().background(.regularMaterial) } }
            .alert("Porchday", isPresented: Binding(get: { store.dialog != nil }, set: { if !$0 { store.answerDialog(false) } })) {
                if store.dialog?.kind == .prompt { TextField("Response", text: $store.dialogInput) }
                Button("OK") { store.answerDialog(true) }
                if store.dialog?.kind != .alert { Button("Cancel", role: .cancel) { store.answerDialog(false) } }
            } message: { Text(store.dialog?.message ?? "") }
            .sheet(isPresented: $store.showPreviousApp) { PreviousNativeApp().frame(minWidth: 320, minHeight: 500) }
            .onOpenURL { store.open($0) }
            .onChange(of: phase) { _, value in store.setActive(value == .active) }
            .task { store.setActive(phase == .active) }
            #if os(iOS)
            .sheet(isPresented: Binding(get: { store.downloadURL != nil }, set: { if !$0 { if let url = store.downloadURL { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }; store.downloadURL = nil } })) { if let url = store.downloadURL { ShellExportSheet(url: url) } }
            #endif
    }
}

struct PreviousNativeApp: View {
    @StateObject private var model = AppModel()
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 0) { HStack { Text("Previous app"); Spacer(); Button("Return to Porchday") { dismiss() } }.padding(); RootView().environmentObject(model).environmentObject(model.vault) }
            .task { await model.restore(); await model.refreshHistoricalPosts(); await NativeNotifications.shared.refresh(model: model) }
    }
}
