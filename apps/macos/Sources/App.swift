import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var downloads: [ObjectIdentifier: WKDownload] = [:]
    let smoke = CommandLine.arguments.contains("--smoke-test")
    var smokeFinished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = smoke ? .nonPersistent() : .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Porchday"
        window.minSize = NSSize(width: 420, height: 500)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        if !smoke {
            window.setFrameAutosaveName("PorchdayMainWindow")
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        webView.load(URLRequest(url: smoke ? URL(string: "https://porchday.org/login")! : NavigationPolicy.home))
        if smoke {
            DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
                self?.finishSmoke(false, "Timed out loading the signed-out page")
            }
        }
    }

    func buildMenu() {
        let menu = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); item.title = title
            let child = NSMenu(title: title); item.submenu = child; menu.addItem(item); return child
        }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "") {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            menu.addItem(item)
        }
        let app = submenu("Porchday")
        add(app, "About Porchday", #selector(about))
        app.addItem(.separator())
        add(app, "Hide Porchday", #selector(NSApplication.hide(_:)), "h")
        app.addItem(.separator())
        add(app, "Quit Porchday", #selector(NSApplication.terminate(_:)), "q")
        let edit = submenu("Edit")
        add(edit, "Undo", Selector(("undo:")), "z")
        add(edit, "Redo", Selector(("redo:")), "Z")
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        let view = submenu("View")
        add(view, "Home", #selector(home), "1")
        add(view, "Reload", #selector(reload), "r")
        add(view, "Back", #selector(back), "[")
        add(view, "Forward", #selector(forward), "]")
        let windows = submenu("Window")
        add(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(windows, "Close", #selector(NSWindow.performClose(_:)), "w")
        NSApp.windowsMenu = windows
        let help = submenu("Help")
        add(help, isTestFlight ? "Open TestFlight" : "Download App Updates", #selector(updates))
        add(help, "Porchday Help", #selector(helpPage))
        NSApp.mainMenu = menu
    }
    @objc func about() { NSApp.orderFrontStandardAboutPanel(nil) }
    @objc func home() { webView.load(URLRequest(url: NavigationPolicy.home)) }
    @objc func reload() { webView.reload() }
    @objc func back() { webView.goBack() }
    @objc func forward() { webView.goForward() }
    var isTestFlight: Bool { Bundle.main.object(forInfoDictionaryKey: "PorchdayDistribution") as? String == "TestFlight" }
    @objc func updates() {
        let destination = isTestFlight ? "https://testflight.apple.com/" : "https://github.com/porchday/porchday/releases"
        NSWorkspace.shared.open(URL(string: destination)!)
    }
    @objc func helpPage() { webView.load(URLRequest(url: URL(string: "https://porchday.org/help")!)) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload {
            let trusted = action.sourceFrame.securityOrigin.host == "porchday.org"
            decisionHandler(trusted && (NavigationPolicy.isInternal(url) || url.scheme == "blob") ? .download : .cancel)
            return
        }
        if NavigationPolicy.isInternal(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        if action.navigationType == .linkActivated && NavigationPolicy.canOpenExternally(url) && !smoke {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard smoke else { return }
        // Ephemeral signed-out store: no member session or keys are accessed.
        webView.callAsyncJavaScript("""
          for (let i = 0; i < 100 && !document.querySelector('input[type="password"]'); i++) await new Promise(r => setTimeout(r, 100));
          const hasLogin = !!document.querySelector('input[type="password"]');
          const bytes = new Uint8Array(await new File(['photo-read-check'], 'test.txt').arrayBuffer());
          return hasLogin && bytes.length === 16 && !!crypto.subtle && typeof indexedDB.open === 'function';
        """, arguments: [:], in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let value): self?.finishSmoke(value as? Bool == true, "Signed-out UI, file bytes, Web Crypto and IndexedDB availability")
            case .failure: self?.finishSmoke(false, "WebKit capability check failed")
            }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if smoke { finishSmoke(false, "Web content process exited"); return }
        alert("Porchday needs to reload", "The web process stopped. Unsaved work may have been lost. Use View → Reload to reconnect.")
    }
    func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if smoke { finishSmoke(false, "Navigation failed"); return }
        alert("Could not load Porchday", "Check your connection, then choose View → Reload. Your saved sign-in and keys have not been cleared.")
    }
    func finishSmoke(_ success: Bool, _ message: String) {
        guard !smokeFinished else { return }; smokeFinished = true
        print("\(success ? "PASS" : "FAIL"): \(message)")
        exit(success ? 0 : 1)
    }
    func alert(_ title: String, _ message: String) {
        let dialog = NSAlert(); dialog.messageText = title; dialog.informativeText = message
        dialog.beginSheetModal(for: window)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.securityOrigin.host == "porchday.org", !smoke else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let dialog = NSAlert(); dialog.messageText = "Porchday"; dialog.informativeText = message
        dialog.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let dialog = NSAlert(); dialog.messageText = "Porchday"; dialog.informativeText = message
        dialog.addButton(withTitle: "Continue"); dialog.addButton(withTitle: "Cancel")
        dialog.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { track(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { track(download) }
    func track(_ download: WKDownload) { downloads[ObjectIdentifier(download)] = download; download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            // NSSavePanel has already obtained confirmation before replacing an existing file.
            do {
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                completionHandler(url)
            } catch { completionHandler(nil) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeValue(forKey: ObjectIdentifier(download)) }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        if (error as NSError).code != NSURLErrorCancelled { alert("Download did not finish", "Try exporting again. An incomplete file may remain at the location you chose.") }
    }
}
@main
struct PorchdayApplication {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
