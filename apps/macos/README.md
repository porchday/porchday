# Native Porchday for Mac

The Mac target is `PorchdayMac` in [the shared Apple project](../ios/project.yml).
It shares SwiftUI screens, URLSession, encryption and Keychain code with iOS under
`org.porchday.app`. It does not load the website in a web view.

Build with full Xcode 26.3, Go and XcodeGen using `apps/macos/build.sh`.
The generated Xcode project is not source; edit `apps/ios/project.yml` instead.
macOS 14 or later is required. Distribution signing, sandbox execution, hardware
acceptance and TestFlight processing must pass before this is an installable release.

The old `org.porchday.macos` WebKit preview is retired. Its browser storage is not
native Keychain storage. Do not delete an installed preview's data until native
sign-in and encrypted history recovery have been verified with your recovery secret.
Historical preview commits and receipts remain history, not the current app.

## Native parity before production

Every forward production release must satisfy the [iOS/macOS parity checklist](../../docs/native-parity.md). Review equivalent behavior across web, iOS and macOS, and run both native workflows on the exact candidate commit. The production activation CLI rejects pending capability checks, failed or skipped required native build/test steps, and CI from a different source. Update private release-tool pins to include this gate before any forward production activation. Emergency recovery and rollback remain available. Build verification is separate from signed distribution and physical-device acceptance.

### Share from Photos

The current source embeds a Porchday Share extension. After installing a signed build containing it, choose photos/videos in Photos, then Share → Porchday (enable it in macOS Extensions if needed). Choose Add to Porchday, then open Porchday → Share to add the waiting items to your draft. Choose the audience and publish there. Nothing is uploaded by the extension. Pending local files expire after seven days. The existing shared web UI still works in older builds, but the extension requires an app update. See [the design](../../design/unified-media-picker.md) and #183 for distribution/verification status.
