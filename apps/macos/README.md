# Native Porchday for Mac

The Mac target is `PorchdayMac` in [the shared Apple project](../ios/project.yml).
It shares the retained WKWebView shell and native bridges with iOS under
`org.porchday.app`, loading the same production web UI as the PWA. Native bridges
provide Photos/files, notifications, badges and sharing. Web changes arrive from
production; native bridge changes require a signed app update. See the
[shared-shell design](../../design/shared-web-native-shell.md) and
[notification release evidence](../../docs/evidence/notification-previews-release-2026-11-08.md).

Build with full Xcode 26.3, Go and XcodeGen using `apps/macos/build.sh`.
The generated Xcode project is not source; edit `apps/ios/project.yml` instead.
macOS 14 or later is required. Distribution requires signing, sandbox checks and
Apple processing. Physical-device behavior remains a tracked acceptance follow-up;
it does not block web/API production deployment.

The old `org.porchday.macos` preview is separate from the current app bundle.
Do not delete its data until sign-in and encrypted history recovery have been
verified in the current app with your recovery secret.
Historical preview commits and receipts remain history, not the current app.

## Native parity before production

Every forward production release must satisfy the [iOS/macOS parity checklist](../../docs/native-parity.md). Review equivalent behavior across web, iOS and macOS, and run both native workflows on the exact candidate commit. The production activation CLI rejects missing implementation, failed or skipped required native build/test steps, and CI from a different source. Hosted-native and physical-device checks may remain pending with linked follow-up issues; they do not block production. Update private release-tool pins to include this gate before any forward production activation. Emergency recovery and rollback remain available. Build verification is separate from signed distribution and physical-device acceptance.

### Share from Photos

The current source embeds a Porchday Share extension. After installing a signed build containing it, choose photos/videos in Photos, then Share → Porchday (enable it in macOS Extensions if needed). Choose Add to Porchday, then open Porchday → Share to add the waiting items to your draft. Choose the audience and publish there. Nothing is uploaded by the extension. Pending local files expire after seven days. The existing shared web UI still works in older builds, but the extension requires an app update. See [the design](../../design/unified-media-picker.md) and #183 for distribution/verification status.
