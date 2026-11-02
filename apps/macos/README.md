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
