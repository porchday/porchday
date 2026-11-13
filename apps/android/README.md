# Porchday for Android

Android package `org.porchday.app` uses Google's Trusted Web Activity (TWA) to run the production Porchday client at `https://porchday.org/`. It shares the browser's session, encrypted IndexedDB storage, service workers, uploads, exports and web-push path. It does not port the SwiftUI fallback or add a native crypto bridge. Requires Android 9+ and a compatible, updated browser; Chrome is the initial device-test target.

## Build

Install JDK 17 and Android SDK platform 36/build tools through Android Studio. Configure `ANDROID_HOME` or your ignored `local.properties`, then:

```sh
cd apps/android
./gradlew testDebugUnitTest lintDebug assembleDebug bundleRelease
```

The Gradle wrapper and distribution have pinned SHA-256 verification. CI produces a debug-signed APK, unsigned release AAB, test/lint reports, source SHA and checksums. Artifacts are build evidence, not Google Play publication. The app contains no native `.so` libraries; browser binaries are supplied by the user's browser provider.

For a signed upload, supply all four environment variables from a private secret loader: `PORCHDAY_ANDROID_KEYSTORE`, `PORCHDAY_ANDROID_STORE_PASSWORD`, `PORCHDAY_ANDROID_KEY_ALIAS`, `PORCHDAY_ANDROID_KEY_PASSWORD`. Never commit a keystore or put passwords in Gradle command arguments. Partial configuration fails. Increment `-PversionCode=N` for each Play upload. Do not regenerate an existing upload key; reconcile it with the Play account first. No upload key or Google credential has been configured by this change.

## Origin and storage boundaries

Only HTTPS porchday.org (default port or 443) is accepted from incoming VIEW intents. Other destinations fall back to the home page. All external intent extras, ClipData and grants are discarded. The launch URL is not logged because it may contain invitation/recovery tokens. No share-target or arbitrary file-handler intent is exported. Ordinary upload selection happens through the browser/OS picker without broad storage permissions.

The browser verifies Digital Asset Links before granting fullscreen display. An unverified build uses a visible Custom Tab; never disable verification to claim acceptance. External navigation remains browser-controlled. Native backups are disabled, but browser-owned storage has its own lifecycle: uninstalling the Android package does not necessarily clear browser sessions/keys. Members use Porchday logout/device controls and browser site-data controls. Clearing browser storage can require account recovery; test that explicitly.

The AndroidX delegation service verifies the caller's browser token; notification delivery/permission still needs installed-device validation. Do not claim Apple notification preview behavior is identical: Android uses the existing web-push implementation.

## Domain association and release

After Play App Signing is enabled, obtain the **app-signing certificate** SHA-256 from Play Console. The upload certificate and local debug certificate are not substitutes. Prepare the `org.porchday.app` `android_app` statement with `delegate_permission/common.handle_all_urls` and the verified signing fingerprint at `https://porchday.org/.well-known/assetlinks.json`. Preserve any existing statements. No placeholder or debug certificate should be trusted by production.

Deploy this association through the normal reviewed staging/production release process, then check HTTP 200 JSON without redirects and verify the Play-installed app's domain/fullscreen behavior. No domain association or website change is included in this PR.

Full distribution checklist and remaining gaps are tracked in [#231](https://github.com/porchday/porchday/issues/231) and [the release plan](../../docs/android-play-release.md).
