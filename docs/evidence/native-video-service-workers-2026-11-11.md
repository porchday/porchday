# Native encrypted video playback — November 11, 2026

[PR #220](https://github.com/porchday/porchday/pull/220), tracked in [#49](https://github.com/porchday/porchday/issues/49) and [#114](https://github.com/porchday/porchday/issues/114).

## Cause and change

The owner reported the same video playing in the PWA but failing in the TestFlight app with “Video streaming is unavailable in this browser. Try the native app.” That exact error is raised when `navigator.serviceWorker` is absent. The shared iOS shell omitted both `WKAppBoundDomains` and `limitsNavigationsToAppBoundDomains`, which iOS WebKit requires for this service-worker streaming path. Prior browser tests did not exercise this installed-shell capability boundary.

The app bundle now declares only the existing production/staging hosts. iOS enables app-bound navigation before constructing WKWebView; existing exact-HTTPS-origin navigation and bridge checks remain. macOS already exposes service workers and ignores the iOS-specific flag. Both platforms have a regression checking actual service-worker and native-bridge exposure in WKWebView, plus packaged domain configuration. This retains encrypted, authenticated range streaming and existing expiry/access controls.

The web source also corrects guidance for older native shells. **No web/API production deployment was performed in this release**; that wording change is ready for a subsequent web release. The native configuration fix works with the existing production player.

## Validation and distribution

Native distribution source: `daf5369d0a63fecbcf8fccad43996d8dcac76960`. Subsequent source `565c52097c3d97772c5a815f7ec2f42a0b5aec15` changes only CI preparation; `apps/ios`, `apps/macos` and `packages/crypto` trees match exactly.

- [iOS simulator tests and signed archive](https://github.com/porchday/porchday/actions/runs/43046478169) passed: 152 unit tests with four opt-in tests skipped, plus three passing UI tests. The new service-worker capability test passed. Skipped hosted checks are not counted as verified.
- [macOS tests and signed package](https://github.com/porchday/porchday/actions/runs/43046173835) passed: 86 tests, including actual service-worker/bridge exposure.
- Local web typecheck, Chromium/WebKit encrypted streaming checks (cross-chunk seeking, tab isolation, invalid ranges and revocation), and repository tests passed. Local suite: 1,370 passed / 327 skipped.
- Full CI [43049136844](https://github.com/porchday/porchday/actions/runs/43049136844) and [43049150454](https://github.com/porchday/porchday/actions/runs/43049150454), secret scan, post-detail, invitation and reaction browser checks passed on the CI-fallback source.
- Downloaded archive hashes and exact source matched their build evidence. The actual IPA and Mac package Info.plists contain the expected domains and bundle identity. Signing/provisioning checks passed in the archive workflows.
- **iOS 0.1.0 (424)** and **macOS 0.1.0 (410)** processed successfully; both were read back as `IN_BETA_TESTING`, with existing internal owner-group membership verified.

An initial iOS group assignment returned 404 despite successful build lookup. Read-back confirmed the build existed and membership was absent; a later assignment and final read-back succeeded. No archive was re-uploaded. Private receipts preserve both attempts.

## CI infrastructure failure

The first macOS test run caught an overbroad assertion about the iOS-specific configuration flag. It was corrected, retaining the real runtime capability assertion on both platforms; no failed candidate was distributed.

Linux browser CI then failed DNS resolution for Ubuntu archive hosts, before application tests. The preparation helper now selects a reachable archive with bounded checks, including the independently hosted Linux Kernel Archives Ubuntu mirror. APT still verifies signed repository metadata/package hashes, and all required tests remain enabled. Failure to reach any mirror stops CI. Local primary/fallback/fail-closed checks passed; hosted full CI passed after the independent fallback. Follow-up evidence is in [#3](https://github.com/porchday/porchday/issues/3).

## Remaining acceptance

Physical playback of the reported clip, seeking, and background/foreground behavior on the updated iPhone and Mac remain unperformed and tracked as `needs verification` in #49/#114. The automated native capability test is not a claim that this specific private clip was played on a physical device. Internal TestFlight availability is not public App Store publication.
