# Notification previews and native tap hardening — November 8, 2026

[PR #193](https://github.com/porchday/porchday/pull/193) is merged. Web/API changes are live in staging and production. Opt-in feed notifications now identify the author’s handle and activity type, such as “@alex shared a post” or “@alex shared photos/videos”. Delivery still rechecks access, unread state, mutes and blocks. Encrypted post text, captions, media and private display names are not sent to push providers. Missing/invalid preview metadata uses the existing generic fallback; unrelated notification JSON is unchanged.

## Deployed versions

| Environment | Component | Source | Worker version |
| --- | --- | --- | --- |
| staging | API | `a36d2cd146c542e31576c46c23dde4459b9a6bb4` | `46053087-7233-4463-a5d9-ff22cb700e4b` |
| staging | Frontend | `83e67bbe93fd9a8963a56521a36d6b6442d172f6` | `dcb0e215-1bf9-41e5-a7b9-7f9d6f39d65f` |
| production | API | `ac349af8c1734bb911e9bf269c2fb90de57b1ce3` | `255f28f5-1031-46f0-b0db-a1351c3b0b95` |
| production | Frontend | `83e67bbe93fd9a8963a56521a36d6b6442d172f6` | `191be1fa-5677-4eae-a8f5-ecdd5383f5d1` |

Migration `077_feed_notification_previews.sql` changes only the two authorized push-delivery JSON projections. Existing environment-specific authentication/session runtimes are preserved. Old workers and clients remain compatible. Deployment used the maintained activation CLI, exact-source native parity checks, retained assets, authenticated continuity and rollback preparation.

## Validation

- Full web/API CI passes for each deployed source. All 33 targeted feed/Web Push/native push database tests pass, including non-feed payload compatibility and access/read isolation.
- Hosted staging and production checks verify both native and browser delivery preparation with authorized author/type metadata and suppression after mute. Synthetic fixtures exist only inside a rolled-back transaction; no provider alerts were sent by that check.
- Authenticated continuity, routes, shared-shell behavior, automatic updates, encrypted draft preservation and Settings preview disclosure pass on both environments. All release fixtures are cleaned up.
- Production monitoring passed eight samples over 140,006 milliseconds with zero failures. Final provider/schema reconciliation passed at 2026-11-09 02:12:27 UTC, confirming both live versions, enabled publication, zero remaining fixtures and verified TestFlight group availability.

| Candidate | Web/API CI | iOS CI | macOS CI |
| --- | --- | --- | --- |
| Frontend | [42546558571](https://github.com/porchday/porchday/actions/runs/42546558571) | [42546558536](https://github.com/porchday/porchday/actions/runs/42546558536) | [42546558424](https://github.com/porchday/porchday/actions/runs/42546558424) |
| Staging API | [42546684799](https://github.com/porchday/porchday/actions/runs/42546684799) | [42546684905](https://github.com/porchday/porchday/actions/runs/42546684905) | [42546684789](https://github.com/porchday/porchday/actions/runs/42546684789) |
| Production API | [42546686760](https://github.com/porchday/porchday/actions/runs/42546686760) | [42546686554](https://github.com/porchday/porchday/actions/runs/42546686554) | [42546686766](https://github.com/porchday/porchday/actions/runs/42546686766) |

## Native distribution

- iOS **304**, version 0.1.0, source `83e67bbe93fd9a8963a56521a36d6b6442d172f6`: signed archive from [42546755758](https://github.com/porchday/porchday/actions/runs/42546755758). Signature, bundle/build identity, production APNs entitlement and associated domains verified. Apple reports `VALID` and `IN_BETA_TESTING`; membership in the existing internal TestFlight group is verified.
- macOS **267**, version 0.1.0, source `0afd4b54c7c5ace328b774175c3e62da97ad8030`: signed package from [42544493258](https://github.com/porchday/porchday/actions/runs/42544493258), `VALID` and `IN_BETA_TESTING` in the existing internal group. App/share-extension signatures, shared app group, production APNs, sandbox and extension network restrictions verified. Application/share-extension source matches the final candidate; subsequent changes concern SQL compatibility, tests and documentation. The final Mac CI above includes the new notification tests explicitly.

These are TestFlight releases, not a claim of an App Store release or installation on a particular device.

## Crash investigation and remaining verification

The owner reported an iOS crash after tapping a notification. App Store Connect returned no submitted crash diagnostic during investigation, and no aggregate diagnostic was available through the build endpoint. The root cause is **unconfirmed**.

Both native targets now decode notification callbacks outside the UI actor, pass only Sendable values to MainActor, explicitly acknowledge completion, ignore dismissals and avoid initializing the retired native notification model for production taps. The existing pending destination survives until the web shell can navigate. Tests verify background-callback routing/acknowledgment order and malformed-payload/dismissal handling on both platforms. Content-free OSLog breadcrumbs support further diagnosis.

This is tested callback hardening, **not a verified fix for the reported device crash**. Real-device receipt/tap behavior, cold launch and crash confirmation remain `needs verification` in [#7](https://github.com/porchday/porchday/issues/7) (P1). Signed distribution and device acceptance remain tracked in [#49](https://github.com/porchday/porchday/issues/49) and [#114](https://github.com/porchday/porchday/issues/114). Physical checks did not block production.
