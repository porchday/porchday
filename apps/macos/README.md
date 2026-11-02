# Porchday for macOS — preview

A standalone Mac application using AppKit and Apple's WebKit engine. It opens the hosted Porchday web client at **https://porchday.org/app**. Chrome is not required. This is a native window around the web client, not a port of the SwiftUI iOS client or an offline/local Porchday server.

## Install

1. Open the [macOS preview release](https://github.com/porchday/porchday/releases/tag/macos-v0.1.0-preview.1), or [download the ZIP directly](https://github.com/porchday/porchday/releases/download/macos-v0.1.0-preview.1/Porchday-0.1.0-macOS-universal.zip).
2. Download `Porchday-0.1.0-macOS-universal.zip`, unzip it, and drag **Porchday.app** into **Applications**.
3. Open Porchday. This preview is ad-hoc signed, **not Developer ID signed or Apple-notarized**. If macOS blocks it, follow Apple's per-app **System Settings → Privacy & Security → Open Anyway** flow after attempting to open it. See [Apple's instructions](https://support.apple.com/en-us/102445). Do not disable Gatekeeper globally.
4. Sign in. This app has its own browser storage: your Chrome login and encryption keys do **not** transfer. Have your Porchday encryption recovery secret available to restore access to existing encrypted content. Keep your existing working Chrome app until you confirm your history opens here.

Requires macOS 13 Ventura or later. The same universal binary includes Apple silicon and Intel code. Intel is cross-compiled; physical Intel-device acceptance is not yet claimed. SHA256SUMS.txt accompanies the archive.

To verify the download, save both the ZIP and `SHA256SUMS.txt` from that release in the same folder, open Terminal in that folder, and run `shasum -a 256 -c SHA256SUMS.txt`. The ZIP should report `OK`.

## What works and what needs verification

- Native window, Dock icon, standard editing shortcuts, Home (Command-1), back/forward, reload, and window reopening.
- Persistent WebKit website storage for the web client's session and encrypted device state, separate from Chrome. The shell does not log passwords, cookies, content, or recovery secrets.
- System file selection and save dialogs for uploads/downloads. The web client still validates and encrypts media. Actual Photos-library selection and account export need an owner-device check; switching from Chrome does not prove the Photos-picker problem is fixed.
- Same-origin navigation stays inside the app. User-clicked external HTTP(S)/email links open in the default external application. Untrusted file/custom/script URLs are blocked. No JavaScript-to-shell or filesystem bridge is exposed.
- Web features update with the hosted service. Shell updates are manual through **Help → Download App Updates**. There is no automatic code download/updater.
- Network access is required. This preview does not promise offline access, native APNs/web push delivery, camera capture, automatic login from an email deep link, or Chrome extension support. Open verification links in your browser, then return to the app to sign in.

The app does not automatically clear keys or browser data after connection failures. Sign out through Porchday's normal controls. Uninstalling the .app is not a verified secure erasure procedure for its WebKit data.

## Build from source

Requires macOS, Python 3, and a matching Apple Swift compiler/macOS SDK from Command Line Tools or full Xcode. No npm dependencies, Apple Developer membership, hosted credentials, or iOS framework build are needed.

```sh
apps/macos/test.sh
apps/macos/build.sh
open apps/macos/build/Porchday.app
```

Output: `apps/macos/build/Porchday.app`, the universal ZIP, and `SHA256SUMS.txt`. The script uses an ad-hoc signature and does not read signing credentials. A compiler/SDK mismatch must be corrected by selecting a matching Xcode/toolchain. If an appropriate older SDK is already installed, you can explicitly select it for both scripts:

```sh
MACOS_SDK_PATH=/path/to/matching/MacOSX.sdk apps/macos/test.sh
MACOS_SDK_PATH=/path/to/matching/MacOSX.sdk apps/macos/build.sh
```

The optional runtime check loads the public login page in a nonpersistent WebKit store and checks rendered login controls, a synthetic File read, Web Crypto and IndexedDB availability. It does not sign in, upload a photo, read a real account, prove IndexedDB persistence, or exercise the native Photos picker:

```sh
apps/macos/build/Porchday.app/Contents/MacOS/Porchday --smoke-test
```

Run this in an interactive macOS login session. CI runs policy tests and compilation/packaging; it does not claim physical-device or signed-in testing. The [macOS workflow](../../.github/workflows/macos.yml) also uploads build artifacts. Tags `macos-v*` publish a clearly marked preview release after a successful build. Set `apps/macos/VERSION` before tagging a new version.

Before stable distribution, add Developer ID signing and notarization through restricted CI secrets, validate installed/quarantined downloads on a clean Mac, and complete signed-in photo/export/relaunch tests on both architectures. No signing credentials belong in this repository.

## TestFlight distribution

The separate `project.yml` generates a sandboxed Mac App Store/TestFlight target
for the existing Mac shell (not the SwiftUI iOS client). It retains bundle ID
`org.porchday.macos`. Apple must register that identifier to the chosen team.
Network client and user-selected read/write files are the only sandbox exceptions.
There is no broad Photos-library, Downloads-folder, camera or microphone grant.
The preview build remains separate and unchanged.

1. Install full Xcode and XcodeGen, sign in to your paid Apple Developer team,
   and select Xcode's developer directory. Run `apps/macos/prepare-testflight.sh`.
2. Open `apps/macos/PorchdayMac.xcodeproj`. Select the team under Signing &
   Capabilities and use automatic signing. Create the matching macOS app record
   in App Store Connect. Keep the identifier consistent with its provisioning profile.
3. Set the version and a new monotonically increasing build number in the source
   `project.yml`, then regenerate. Complete the encryption/export classification
   for the actual hosted encryption implementation; no exemption is assumed here.
4. Run a signed sandboxed development build. Verify login/recovery using an owned
   test account, persistent keys after relaunch, photo/video selection, export via
   the save panel, and external-link handling. The sandbox has a different storage
   location from the unsandboxed preview; do not promise automatic session/key
   migration or delete the preview's data. Have the recovery secret available.
5. Select Product → Archive, then Organizer → Distribute App → App Store Connect.
   Validate the signature, provisioning profile and entitlements before uploading.
   This requires Apple distribution signing; ad-hoc/Developer ID preview signatures
   are not TestFlight distribution signatures.
6. After processing, complete encryption and beta metadata in App Store Connect,
   add an internal TestFlight group and install on a real Mac. For external testers,
   supply review access and submit for TestFlight review. Do not mark distribution
   complete until the processed build can actually be installed from TestFlight.

TestFlight builds open TestFlight for updates rather than linking to preview ZIPs.
Web content still follows the hosted service. Native push is not enabled by this
configuration. Apple review acceptance and signed-in sandbox behavior remain
unverified until tested; compilation alone is not distribution acceptance.

References: [Apple distribution preparation](https://developer.apple.com/documentation/xcode/preparing-your-app-for-distribution),
[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
