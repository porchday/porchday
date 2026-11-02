import SwiftUI
import WebKit

/// A codec surface, never a website: ephemeral storage, no network/navigation,
/// no credentials or application bridge, and only already-decrypted local media.
@MainActor final class LocalWebM: NSObject, WKNavigationDelegate {
    let view: WKWebView
    private var ready: CheckedContinuation<Void, Error>?
    private var deadline: Task<Void, Never>?
    static let html = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <style>html,body{margin:0;background:#000;height:100%}video{width:100%;height:100%;object-fit:contain}</style>
    <video controls playsinline preload="auto"></video>
    """
    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
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
    func open(_ bytes: Data) async throws -> PreparedPhoto {
        guard try VideoContainer.mime(bytes) == "video/webm" else { throw PorchError.message("Invalid WebM video.") }
        try await navigationLoaded()
        try Task.checkCancellation()
        // Arguments are structured values, never interpolated into JavaScript/HTML.
        let result = try await view.callAsyncJavaScript("""
        const v = document.querySelector('video');
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Video decoding timed out')), 15000);
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
              resolve({width:w, height:h, poster:c.toDataURL('image/jpeg', 0.8).split(',')[1]});
            } catch (_) { fail(); }
          };
          v.src = 'data:video/webm;base64,' + encoded;
          v.load();
        });
        """, arguments: ["encoded": bytes.base64EncodedString()], in: nil, contentWorld: .defaultClient)
        try Task.checkCancellation()
        guard let metadata = result as? [String: Any], let width = metadata["width"] as? Int, let height = metadata["height"] as? Int,
              let poster = metadata["poster"] as? String, let image = Data(base64Encoded: poster), image.count <= 200_000 else { throw PorchError.message("Invalid decoded video metadata.") }
        _ = try PhotoPipeline.safelyDecode(image)
        return PreparedPhoto(bytes: bytes, width: width, height: height, mime: "video/webm", poster: poster)
    }
    func stop() {
        finish(CancellationError())
        view.stopLoading()
        view.evaluateJavaScript("const v=document.querySelector('video'); if(v){v.pause();v.removeAttribute('src');v.load();}")
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
