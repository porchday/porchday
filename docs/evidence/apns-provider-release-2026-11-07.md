# Native push provider release — November 7, 2026

The existing owner-created Apple push key is configured as private server secrets in staging and production. No new key was created by this release. The key is production-only and restricted to the two Porchday app topics. Both currently distributed builds use `org.porchday.app`.

The API executable and database schema are unchanged. API versions changed solely to introduce APNs provider configuration through the maintained inactive-upload and observed-activation process. Public frontend versions remain unchanged.

| Environment | API source | API version |
| --- | --- | --- |
| Staging | `11710b8ceb96700fa8b4738466896c3469c53c44` | `c9ef52d6-3b1d-433a-8333-bb4ced984398` |
| Production | `737385bfe2b39854c0d5acfeafccfd7fb1e504d9` | `e53bd596-3c4f-4bbf-b3d5-de45d0396b87` |

## Verification

- Apple’s production endpoint responded over HTTP/2 to a signed request with a deliberately invalid synthetic token.
- Live staging and production checks verified enabled native push configuration, enrolled an isolated synthetic session, published new encrypted feed items, and observed the deployed queue processor revoke the invalid token. This exercises the deployed provider path and invalid-token handling; it does not prove receipt on a device.
- Authorized unread counts, own-post exclusion, idempotent reads, member isolation, mark-all and access removal passed again. Synthetic accounts and their content were cleaned up.
- Observed activations verified authenticated continuity and revoked-session rejection. Eight production monitoring samples passed over 140 seconds with zero failed samples. This is a bounded observation window, not a long-term availability claim.
- Required exact-source iOS/macOS CI was verified by the production activation gate. Fresh Apple readbacks confirmed iOS 239 and Mac 198 remain `VALID` / `IN_BETA_TESTING` in the owner’s internal group. No new binary upload was necessary.

## Member experience and remaining verification

Members can opt into native notifications in Settings in iOS 239 or Mac 198. Every newly eligible feed post or standalone photo can produce a generic alert. Unread counts and reading progress remain shared across devices. Nothing enables OS notification permission automatically.

Actual device receipt, lock-screen presentation, permission denial, background badge/Dock synchronization, token rotation and physical installation remain tracked under [#7](https://github.com/porchday/porchday/issues/7), with distribution milestones in #49 and #114. They are not represented as passed by synthetic or build checks. Browser badge clearing while closed remains platform-limited.

See [the original release evidence](feed-notifications-release-2026-11-06.md) and [the design](../../design/feed-notifications.md). Private provider credentials, tokens and test-session material are excluded from this document.
