# Encrypted notification content preview release — November 8, 2026

[PR #199](https://github.com/porchday/porchday/pull/199) implements [the design](../../design/notification-content-previews.md). Production API and web activation and hosted acceptance completed November 9 UTC (November 8 Pacific).

## Released behavior

New eligible feed notifications can show the author's handle, up to 240 characters of post text or photo/video caption, and a bounded photo/video-poster thumbnail where the notification platform supports images. Taps open the referenced post or standalone photo. Settings → Notifications offers a per-device content-preview toggle, enabled by default for opted-in push devices. Push notifications remain opt-in.

The publishing device signs and encrypts preview material for separate notification-only keys. PWA service workers and iOS/macOS notification service extensions decrypt locally. Account/recovery keys never enter the extension; server storage and push-provider payloads contain no preview plaintext. Retrieval rechecks session/device/subscription, current audience, unread state, deletion, revision, expiry, blocks and mutes. Unknown pinned author keys, missing enrollment, expired retrieval tokens and other failures retain the generic alert.

## Exact deployed sources and versions

| Environment | API source | API Worker version | Web source | Web Worker version |
| --- | --- | --- | --- | --- |
| Staging | `21dc5bf2771ac76979d1be9b7cc34af55b72c717` | `d11503d5-d27f-41c0-a509-5492ccdde0d8` | `26293c3cb57fafa08b421a2eb8402198831991b3` | `f591ab24-df80-4b58-9864-d6c8bd45092a` |
| Production | `633f0a33d5b0bbf98d6d693c8b5041abf78d7217` | `dee51e55-032d-4668-913f-6074c79455da` | `26293c3cb57fafa08b421a2eb8402198831991b3` | `45dcb91b-603c-48c4-a77e-34232dc036af` |

Migration `078_notification_content_previews.sql` is additive and verified on both databases. API release branches preserve each environment's existing auth/session runtime. Old clients and rollback versions remain compatible. Retained assets, authenticated continuity, canonical-domain routes, login gates and installed-shell/update behavior passed maintained activation checks.

## Validation

- [Frontend CI](https://github.com/porchday/porchday/actions/runs/42577790647) passed on attempt 2; [same-source PR CI](https://github.com/porchday/porchday/actions/runs/42577796808) passed on attempt 1. The initial intermittent WebKit reload fetch errors are tracked as an investigation in [#200](https://github.com/porchday/porchday/issues/200), not claimed as a confirmed user-facing defect.
- [Production API CI](https://github.com/porchday/porchday/actions/runs/42577943225) and [staging API CI](https://github.com/porchday/porchday/actions/runs/42577815138) passed. A hosted staging failure exposed array serialization with `fetch_types: false`; commit `26293c3` fixes it using JSON-to-UUID-array conversion, with a regression that failed before the fix and passed afterward. All 12 feed/preview database checks pass.
- Real Chromium service-worker tests decrypt signed previews and exercise tamper, missing-key, unpinned-author, denied-token and logout fallback. Native fixture tests verify WebCrypto/OpenPGP/CryptoKit interoperability, wrong-recipient rejection, safe destinations and attachment-file lifetime.
- Exact-source [frontend iOS](https://github.com/porchday/porchday/actions/runs/42577790587), [frontend macOS](https://github.com/porchday/porchday/actions/runs/42577790551), [production API iOS](https://github.com/porchday/porchday/actions/runs/42577943347) and [production API macOS](https://github.com/porchday/porchday/actions/runs/42577943066) checks passed.
- Both hosted environments passed real authenticated publication, signed preview-key enrollment, recipient-only decryption, invalid-token/mute denial and immediate opt-out invalidation. Synthetic publication preceded subscription enrollment; no fake APNs delivery was queued.
- Hosted mobile checks verified preview preference defaults, opt-out persistence across reload and re-enabling; draft/photo/date preservation across navigation and automatic updates; settings layout and diagnostic-consent restoration. Test-harness assertions were updated for the new wording and asynchronous saved-state hydration. Original failure evidence was retained and fixtures reconciled before replacement tests.
- All synthetic member/account fixtures were removed. Production monitoring recorded **9 healthy samples**, **0 failed samples**, across **160 seconds** following the final web activation, covering login/logout, authorized reads, revocation, readiness and monitor freshness.

## Native availability and remaining acceptance

**iOS 337** and **macOS 320**, version 0.1.0, are `VALID` and `IN_BETA_TESTING` in the existing internal TestFlight group. [Signed iOS build](https://github.com/porchday/porchday/actions/runs/42576153765) and [signed macOS build](https://github.com/porchday/porchday/actions/runs/42576156658) use `bcddeeee008bdc9dd046111554a8bef0177ec7b1`; native, web and crypto sources are identical to the final frontend candidate (the later change fixes only API lookup and its test).

Actual signed packages were checked for embedded notification service extensions, matching expanded shared-keychain metadata and signed entitlements, valid signatures and framework placement. The archive scripts now assert these packaging requirements. Both uploaded builds were processed by Apple and their membership in the existing internal group was verified.

Install the new native build and open it once while signed in to enroll its notification key. A web rollout cannot add an extension to an older installed binary. Newly enrolled keys apply to subsequent publications; old notifications are unchanged. Browser image rendering and lock-screen visibility remain controlled by the platform/system settings.

Physical iPhone/Mac lock-screen receipt, thumbnail rendering, cold-start taps and device-specific resource behavior remain **needs verification** in [#7](https://github.com/porchday/porchday/issues/7), [#49](https://github.com/porchday/porchday/issues/49) and [#114](https://github.com/porchday/porchday/issues/114). No physical-device test is claimed. This does not resolve the earlier unconfirmed crash report or publish the Mac app to the public App Store.
