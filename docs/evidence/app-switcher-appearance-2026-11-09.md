# Native app-switcher appearance — November 9, 2026

[PR #209](https://github.com/porchday/porchday/pull/209), source `e71bbd3ed5e3c64e147a630eb5ec3260eea7aa02`, addresses [#208](https://github.com/porchday/porchday/issues/208).

The inactive-scene privacy cover had a hard-coded cream background and an implicit label color. It now uses the selected Autumn, Clean or generated pattern's base color with a contrasting black/white label. A document-end, main-frame-only observer follows the existing web appearance application. The existing exact-HTTPS-origin native bridge accepts only an opaque six-digit hex color. Only that non-content preference is stored in UserDefaults and restored on launch; Autumn is the initial fallback. No page snapshots, post content or member data cross this bridge.

Validation:

- Local observer checks passed for initialization, changes, deduplication and invalid values.
- Exact-source Verify Porchday 42711006198 / 42711069818, secret scan and Chromium/WebKit post-detail browser checks passed.
- [iOS tests and signed archive](https://github.com/porchday/porchday/actions/runs/42711065387) passed.
- [macOS tests and signed package](https://github.com/porchday/porchday/actions/runs/42711069918) passed, including 85 native tests and color validation/persistence.
- iOS reported 151 unit tests with four opt-in tests skipped and zero failures, plus three passing UI tests. The new color validation/persistence test passed on both platforms; skipped hosted checks are not counted as verified.
- Archive workflows verify signing, bundle identity, notification extension entitlements and package integrity. Downloaded artifact hashes and source IDs matched their signed-build evidence before upload.
- iOS build **362** and macOS build **345** processed successfully and were read back as **IN_BETA_TESTING**, with membership in the existing internal TestFlight group verified.

This is a native-only release. No web/API deployment or schema change was needed. Installed apps need the new native build; opening it applies the existing browser-local preference to the cover. An actual physical iPhone/macOS app-switcher check remains unperformed and tracked as `needs verification` in #208. Internal TestFlight availability is not an App Store public release claim.
