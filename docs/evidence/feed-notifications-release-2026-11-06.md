# Feed notifications release — November 6, 2026

Unread Feed badges, scroll-to-read acknowledgments, Mark all as read, and opt-in Web Push for new posts and standalone photos are live in staging and production. Historical content is not backfilled. Counts exclude the member’s own publications and recheck current access. Push previews contain no names, captions or photos.

## Deployed sources

| Surface | Source | Active version |
| --- | --- | --- |
| Production API | `737385bfe2b39854c0d5acfeafccfd7fb1e504d9` | `aeac67dc-5582-4edc-bd52-fa4d7344a226` |
| Production web | `de4c36e54e2d68a23e5fc9649671d6c949fd39fc` | `fce49804-cc88-490a-a4bb-337886f8cc24` |
| Staging API | `11710b8ceb96700fa8b4738466896c3469c53c44` | `ec134be2-3386-4cc9-af95-0f2f0b5cce34` |
| Staging web | `de4c36e54e2d68a23e5fc9649671d6c949fd39fc` | `8325d3e6-b989-4017-9056-9979b64fc44f` |

Migration `074_feed_notifications.sql` was applied with publication disabled. Readers were deployed before enabling publication in each environment. Existing runtime, session-denial, topology and video configuration were preserved. The maintained activation process verified signed-in continuity, revoked-session rejection, exact public assets and old/fresh browser compatibility.

The first staging frontend attempt rolled back because its observer incorrectly required a default function export from every lazy module. [PR #171](https://github.com/porchday/porchday/pull/171) corrects that assumption while retaining byte, MIME, document and browser-error checks. Twenty-one real Chromium tests passed, including named-export regressions. The subsequent staged and production activations passed. The original rollback and cleanup evidence remains preserved; it is not reported as a successful forward activation.

## Verification

- Thirty targeted database tests passed for receipts and privacy-journal restoration, including idempotence, isolation, history/import exclusions, standalone photos, attachment adoption, concurrent mark-all, delivery suppression, badge clearing and access changes.
- Actual web components passed local Chromium checks for foreground dwell, fast scrolling, hidden tabs, tall posts, locked content, failed images, retry and mark-all. Service-worker checks verified fixed previews, per-publication deduplication, badge values and safe destinations.
- Live staging and production synthetic accounts verified new-publication counts, exclusion of own posts, idempotent reads, member isolation, mark-all, subsequent reads and immediate exclusion after connection removal. All test accounts and their content were removed. These were live API checks; local browser tests are not represented as physical-device delivery tests.
- Eight production monitor samples passed over 140 seconds after activation, covering login, authorized feed/profile reads, logout, revocation and protected readiness, with zero failed samples. This bounded window is not a long-term availability claim.

Exact-source checks: frontend [application CI](https://github.com/porchday/porchday/actions/runs/42332221540), [iOS](https://github.com/porchday/porchday/actions/runs/42332221454), [macOS](https://github.com/porchday/porchday/actions/runs/42332221459); production API [application CI](https://github.com/porchday/porchday/actions/runs/42332304466), [iOS](https://github.com/porchday/porchday/actions/runs/42332304444), [macOS](https://github.com/porchday/porchday/actions/runs/42332304464). Corrected release tooling `50aa9ad` passed [its CI](https://github.com/porchday/porchday/actions/runs/42333752601).

## Native distribution and remaining work

Shared native source `9e3009a2881806ae8c7107aea273b7252d7b8c05` includes the same read-state behavior plus a packaging correction that embeds the notification configuration keys in the signed app. Both archive scripts now assert those keys. A first Mac candidate missing them was quarantined and never uploaded.

- **iOS 0.1.0 (239):** [signed verification](https://github.com/porchday/porchday/actions/runs/42333444398), Apple processing `VALID`, internal state `IN_BETA_TESTING`, owner internal group membership verified.
- **macOS 0.1.0 (198):** [signed verification](https://github.com/porchday/porchday/actions/runs/42333451716), Apple processing `VALID`, internal state `IN_BETA_TESTING`, owner internal group membership verified.

Both packages’ hashes, signatures, embedded push configuration and production APNs entitlements were verified before upload. This is internal TestFlight availability, not public App Store publication or proof of a physical installation.

**Native system push remains disabled:** neither server has APNs provider credentials configured. Apple Developer authentication/provider setup and actual lock-screen delivery remain open under [#7](https://github.com/porchday/porchday/issues/7), together with permission, background/Dock badge and physical-device checks. Web Push provider configuration is enabled, but an actual member-device notification receipt is not claimed. Browser icon clearing while closed remains platform-limited; it reconciles on foreground or a subsequent push.

See the [design](../../design/feed-notifications.md), [native parity checklist](../native-parity.md), and [PR #170](https://github.com/porchday/porchday/pull/170). Physical/device checks remain follow-up verification and did not block web/API production deployment.
