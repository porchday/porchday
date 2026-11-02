import SwiftUI
import WebKit

/// A codec surface, never a website: ephemeral storage, no network/navigation,
/// no credentials or application bridge, and only already-decrypted local media.
@MainActor final class LocalWebM: NSObject, WKNavigationDelegate {
    let view: WKWebView
    private var ready: CheckedContinuation<Void, Error>?
    private var deadline: Task<Void, Never>?
    #if os(macOS)
    private var preparationHost: NSWindow?
    #else
    private var preparationHost: UIWindow?
    #endif
    static let html = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <style>html,body{margin:0;background:#000;height:100%}video{width:100%;height:100%;object-fit:contain}</style>
    <video controls playsinline preload="auto"></video>
    """
    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        configuration.mediaTypesRequiringUserActionForPlayback = []
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 240), configuration: configuration)
        super.init()
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
        // WebKit needs a window attachment. Mac can use an unshown host;
        // iOS needs its foreground scene, beneath the native content.
        #if os(macOS)
        let host = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        host.contentView = view
        preparationHost = host
        #else
        if let host = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive }).flatMap({ $0.windows }).first(where: \.isKeyWindow) {
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            host.insertSubview(view, at: 0)
            preparationHost = host
        }
        #endif
    }
    func navigationLoaded() async throws {
        try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                self?.finish(PorchError.message("Video decoder did not start. Try opening the clip again."))
            }
            view.loadHTMLString(Self.html, baseURL: nil)
        }
    }
    private func finish(_ error: Error? = nil) {
        deadline?.cancel(); deadline = nil
        let continuation = ready; ready = nil
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(PorchError.message("Video decoder stopped.")) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" && navigationAction.navigationType == .other ? .allow : .cancel)
    }
    private func releasePreparationHost() {
        guard preparationHost != nil else { return }
        view.removeFromSuperview()
        #if os(macOS)
        preparationHost?.contentView = nil
        #else
        view.isUserInteractionEnabled = true
        view.accessibilityElementsHidden = false
        #endif
        preparationHost = nil
    }
    func open(_ bytes: Data) async throws -> PreparedPhoto {
        defer { releasePreparationHost() }
        guard preparationHost != nil else { throw PorchError.message("Open the app before decoding a video.") }
        guard try VideoContainer.mime(bytes) == "video/webm" else { throw PorchError.message("Invalid WebM video.") }
        try await navigationLoaded()
        try Task.checkCancellation()
        // Arguments are structured values, never interpolated into JavaScript/HTML.
        let result = try await view.callAsyncJavaScript("""
        const v = document.querySelector('video');
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Video decoding timed out: ready=' + v.readyState + ', network=' + v.networkState + ', paused=' + v.paused + ', supported=' + v.canPlayType('video/webm') + ', visibility=' + document.visibilityState)), 15000);
          const fail = () => { clearTimeout(timer); reject(new Error('This device cannot decode this WebM video')); };
          v.onerror = fail;
          v.onloadeddata = () => {
            try {
              const w = v.videoWidth, h = v.videoHeight;
              if (!(w > 0 && h > 0 && w <= 3840 && h <= 3840 && w*h <= 3840*2160 && Number.isFinite(v.duration) && v.duration > 0)) return fail();
              const c = document.createElement('canvas'); const scale = Math.min(1, 320 / Math.max(w,h));
              c.width = Math.max(1, Math.round(w*scale)); c.height = Math.max(1, Math.round(h*scale));
              c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
              clearTimeout(timer); v.onerror = null; v.onloadeddata = null;
              v.pause(); v.currentTime = 0; v.muted = false;
              resolve({width:w, height:h, poster:c.toDataURL('image/jpeg', 0.8).split(',')[1]});
            } catch (_) { fail(); }
          };
          v.muted = true;
          const raw = atob(encoded); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], {type:'video/webm'}));
          v.dataset.mediaURL = url; v.src = url;
          v.load();
          // WebKit can defer offscreen preload. Explicit muted decoding obtains
          // the first frame, then the handler pauses before presenting controls.
          v.play().catch(fail);
        });
        """, arguments: ["encoded": bytes.base64EncodedString()], in: nil, contentWorld: .defaultClient)
        try Task.checkCancellation()
        guard let metadata = result as? [String: Any], let width = metadata["width"] as? Int, let height = metadata["height"] as? Int,
              let poster = metadata["poster"] as? String, let image = Data(base64Encoded: poster), image.count <= 200_000 else { throw PorchError.message("Invalid decoded video metadata.") }
        _ = try PhotoPipeline.safelyDecode(image)
        return PreparedPhoto(bytes: bytes, width: width, height: height, mime: "video/webm", poster: poster)
    }
    func stop() {
        releasePreparationHost()
        finish(CancellationError())
        view.stopLoading()
        view.evaluateJavaScript("const v=document.querySelector('video'); if(v){v.pause();v.removeAttribute('src');v.load();if(v.dataset.mediaURL)URL.revokeObjectURL(v.dataset.mediaURL);}")
        view.loadHTMLString("", baseURL: nil)
    }
}
#if os(macOS)
struct LocalWebMPlayer: NSViewRepresentable {
    let decoder: LocalWebM
    func makeNSView(context: Context) -> WKWebView { decoder.view }
    func updateNSView(_ view: WKWebView, context: Context) { }
    static func dismantleNSView(_ view: WKWebView, coordinator: ()) { view.stopLoading() }
}
#else
struct LocalWebMPlayer: UIViewRepresentable {
    let decoder: LocalWebM
    func makeUIView(context: Context) -> WKWebView { decoder.view }
    func updateUIView(_ view: WKWebView, context: Context) { }
    static func dismantleUIView(_ view: WKWebView, coordinator: ()) { view.stopLoading() }
}
#endif
