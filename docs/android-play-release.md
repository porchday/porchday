# Android / Google Play release

Owner authorization: November 13, 2026. Tracking: [#231](https://github.com/porchday/porchday/issues/231). Apple store work continues separately in #49/#114 and PR #230.

## Architecture and implementation

Use the existing shared web client through Android Browser Helper 2.7.4 / AndroidX Trusted Web Activity. This preserves the Chromium browser environment used by the PWA, including service-worker range video, browser-owned encrypted storage and passkeys. No new server endpoints or cryptographic protocol are introduced. Explicit VIEW intents are origin-validated and stripped of arbitrary extras before launching. URL logging is suppressed. Permission scope is internet and optional notification delivery; photo selection does not request access to the entire library.

Package: `org.porchday.app`; version 0.1.0 / initial code 1; min SDK 28, target/compile SDK 36; AGP 8.13.2, Gradle 8.13, JDK 17. CI must verify the exact final source before distribution. A debug APK or unsigned AAB alone does not establish runtime readiness or Play availability.

## Account and publishing gates

- Confirm owner Play Console account/type, identity verification and authority; create the app record when access is available. Do not create a fictional account or assert organization status.
- Configure the upload key privately and Play App Signing. Record original provider upload/edit responses and reconcile before retrying an unknown outcome.
- Verify actual Play signing certificate, publish matching Digital Asset Links through normal web release gates, and test the Play-installed app. Production must never trust a placeholder/debug certificate.
- Finish shared public privacy/support work in PR #230, including the owner's public contact choice, accurate operator/retention disclosures and Data safety answers. Include routing/account metadata, optional diagnostic content and builder chat where applicable; encryption does not mean no collection.
- Supply an externally accessible account-deletion resource with a working request path, in addition to Settings deletion. A deletion receipt page alone is not an initiation path.
- Publish explicit child sexual abuse/exploitation prohibitions and establish the actual human child-safety contact/escalation procedure required of Social apps. Existing broad community rules and an 18+ signup rule do not by themselves establish compliance; do not attest to procedures that do not exist.
- Complete target audience/content rating, app access with a dedicated synthetic reviewer account, screenshots/feature graphic, pricing/countries and required agreements. Prior permission to give demo secrets to Apple is not permission to give them to Google: obtain approval or a dedicated Google review account before submission.
- Upload to internal testing and read back processing/track state. If the account is subject to Google's new personal-account policy, complete a closed test with at least 12 continuously opted-in testers for 14 days, then apply for production access. Do not invent tester activity or bypass this gate.
- Submit for production review and verify approved public listing/installability before closing #231.

## Runtime acceptance still to execute

Use isolated synthetic accounts on actual Android/Chrome and at least an emulator where practical. Retain exact package/version/browser/OS evidence:

1. Verified fullscreen launch, installed icon, trusted deep links and rejection of malicious explicit intents; visible browser fallback on failed association or unsupported browser.
2. Login, encrypted history restoration, remembered-device choice, restart persistence, logout and browser-data-clear recovery. Verify browser/PWA session sharing is disclosed and expected.
3. Post/comment/reaction/invitation and calendar flows, photo/video picker and encrypted playback/seek, exports/downloads; no duplicate sends after interruption.
4. Back navigation, external links, rotation, keyboard, accessibility and offline/error recovery; no blank-screen traps.
5. Web push permission grant/denial, foreground/background receipt, tap destinations and logout/revocation behavior. Do not infer these from Apple APNs tests.
6. Current production client plus release candidate, since TWA content updates independently from the APK. Existing hosted production gates continue to apply.

No Google account access, signing, domain association, installed-device journey, review submission or public release is yet verified.

## Primary references checked November 13

- [Trusted Web Activity overview](https://developer.chrome.com/docs/android/trusted-web-activity/)
- [Domain association](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start/)
- [Target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [New personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Social app child safety standards](https://support.google.com/googleplay/android-developer/answer/14747720)
