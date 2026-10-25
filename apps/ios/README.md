# Porchday for iOS

The native client uses SwiftUI and URLSession, with the same authorized social API and signed encrypted envelope format as the web client. It is not a web-view wrapper. Photo selection/camera access, EXIF removal, encryption, recovery, multipart export/import and Keychain storage run on the device.

## Build and test

Install full Xcode with an iOS simulator runtime, Go matching packages/crypto/native/go.mod, and XcodeGen. Node 24 plus npm ci is needed for the shared cryptographic interoperability tests.

    npm ci
    cd packages/crypto/native
    go test ./...
    cd ../../..
    apps/ios/build-native.sh
    xcodebuild -project apps/ios/Porchday.xcodeproj -scheme Porchday \
      -destination 'platform=iOS Simulator,name=iPhone 16' \
      -derivedDataPath apps/ios/build/DerivedData \
      CODE_SIGNING_ALLOWED=NO test

Choose an installed simulator from xcrun simctl list devices available. The build script creates the native Porchcrypto.xcframework from pinned GopenPGP and gomobile dependencies, then generates the Xcode project. Generated binaries/build output are ignored by Git.

The Verify native iOS GitHub Actions workflow builds the bridge and app on a macOS runner, executes native crypto/portability unit tests and onboarding UI tests, launches the app in the simulator, and keeps the test result bundle and screenshot for seven days. It does not use production credentials. DEBUG-only --ui-testing skips automatic session restoration so onboarding UI tests do not depend on production availability; no test argument supplies an authenticated session or bypasses server authorization.

A simulator build requires no Apple Developer account or App Store listing. Running on a physical iPhone requires a signing identity and provisioning selected in Xcode; free personal-team development has Apple-imposed limits. App Store distribution, APNs entitlement and verified Universal Links need the corresponding Apple capabilities and operator configuration. These are separate from simulator verification. The app already accepts validated https://porchday.com/app/post/{UUID} links when a signed build is configured for associated domains; the source does not claim that the domain association is deployed.

## Privacy and data handling

Login cookies and private device keys use kSecAttrAccessibleWhenUnlockedThisDeviceOnly. Keys are not synced to iCloud or written to user defaults. Private content is opened only in memory; URLSession uses no HTTP response cache or shared cookie store. A privacy cover obscures the app in the app switcher. Signing out removes local keys/session state and staged archives.

The account password is independent of the randomly generated encryption recovery secret. Restoring an active account authorizes a fresh device using the independent recovery signing key while recovering old decryption keys for history. A suspended account can open its backup for export without adding a new publishing device. Device fingerprints are pinned locally; this does not constitute an independently witnessed transparency service. Read docs/crypto-protocol.md for the threat model, metadata visible to the service, absence of forward secrecy, and independent review gate.

Archives use the same versioned JSON, JPEG files and ordinary ZIP/OpenPGP format as the web client. Parts hold up to 20 MiB of estimated raw material, capped at 30 MiB per ZIP. Each part has archive_set.id/index; the last supplies total and complete:true. Imports require every part and validate IDs, paths, CRCs, photo SHA-256 checksums and deadlines. Photos can be referenced across parts. Parts are processed separately to avoid retaining a member's entire photo library in memory. The importer validates up to 1,000 selected parts per operation.

Export defaults to a separate high-entropy archive secret; plaintext ZIP is an explicit choice. Staged files use complete file protection. User-saved exports cannot be recalled after a post expires. Imports re-encrypt contributions for the destination account and start as Only me; comments/reactions and standalone photos become private journal posts, while connections and group memberships are reference data. They do not send invitations or recreate another person's threads.

## Release validation

A successful build/test run is evidence of compilation and the exercised flows, not a security audit or a claim of complete behavioral coverage. Before a public launch, record the exact simulator CI run, verify the signed app on a real device against the deployed API, exercise recovery across independent devices, and complete the independent encryption review described in the design. Any missing Apple identity or device test should be recorded as an external prerequisite, never replaced with fabricated test evidence.
