# Shared web UI in Apple apps

The iOS and macOS apps will display the same hosted Porchday UI as the installed PWA in one persistent WKWebView per window. Feed, Share, Albums, Connections, More, settings, authentication and encryption flows come from the web application. Internal navigation must not rebuild or reload the web view. Existing web caching, drafts and scroll behavior remain in the same browser session.

The native layer owns OS notification permission/APNs registration, app badges, file selection, download export and external links. A small versioned, main-frame, exact-origin message bridge exposes only these operations. No arbitrary URL fetch, filesystem path, shell command, cookie or Keychain retrieval is exposed to JavaScript. The web application registers APNs tokens using its own authenticated session. Logout removes the current subscription and clears native badges. Push taps navigate within the same web view.

Use WKWebsiteDataStore.default for persistent cookies, IndexedDB and web storage. Only the fixed production origin is privileged (the existing explicit DEBUG staging switch remains). External HTTPS links open in the system browser; javascript/file/custom-scheme navigation is rejected. File inputs use WebKit's native picker; macOS supplies a native open panel. Downloads are saved to private temporary storage, then explicitly exported through the OS share/save UI. Failed navigation offers retry, without periodic reloads. A web-content process termination offers recovery instead of repeatedly reloading.

## Upgrade and recovery

The old native Keychain store is retained. The web view has its own session and encryption storage, so existing members may need to log in and restore using their recovery secret once. Never silently extract native private keys into web JavaScript. An explicit “Previous app” escape hatch preserves access to the prior interface while migration and device checks are pending. It is not the default interface. New web sessions use the same remembered-device choice as the PWA.

## Acceptance

- iOS and macOS start in the shared web interface, with no duplicate native tab bars or forms.
- Internal routes, back/forward navigation and push taps retain the same web view; scene changes do not reload it.
- Native notifications can be enabled from web Settings and register through the web session; foreground pushes refresh unread state; logout clears native delivery state.
- Badges reflect the shared unread count. Frame/origin restrictions, invalid bridge input, registration failure and external navigation are tested.
- Photo/video selection and downloads use OS affordances without changing encrypted upload/download protocols.
- Tests cover web bridge behavior and native policy/lifecycle; exact-source native CI runs before distribution. Actual device performance, photo-library/iCloud selection, push receipt and app-store acceptance remain explicitly tracked checks.
- Publish web bridge support before distributing the shell. Deliver new internal TestFlight builds; preserve old build availability and record actual deployment/build evidence.

Tracks #168, #49, #114 and #7. This implements the owner's request to replace divergent Swift screens with the PWA UI; it does not claim offline full-app functionality or that a web view alone fixes all web performance issues.
