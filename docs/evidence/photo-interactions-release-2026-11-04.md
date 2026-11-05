# Photo conversations production release — November 4, 2026

Tracking: [#151](https://github.com/porchday/porchday/issues/151). Implementation: [PR #152](https://github.com/porchday/porchday/pull/152). Release policy: [PR #153](https://github.com/porchday/porchday/pull/153).

Web/API deployment and hosted verification completed November 4 Pacific time (November 5 UTC). Standalone photos now have encrypted comments and six emoji reactions from the feed and albums, with a Photo icon/label in the feed. Each photo has one conversation across its sharing paths. Existing photo permissions remain authoritative.

## Deployed versions

| Environment | API source | API Worker | Frontend Worker |
| --- | --- | --- | --- |
| Staging | `25f82efed019972cadfe7bc0e6e848f3777537e0` | `336f75f1-2a64-4f0f-b8e9-949fc1fa30ff` | `7ac2f09f-0667-4dcd-9cac-49acdaf81515` |
| Production | `17ed4b940a3050cf1f5377e1996b37a516734274` | `22920571-07b6-4192-b44e-f2ae87333d3c` | `4959656e-9597-44a6-beb3-7a74b4a055f9` |

Both frontend releases use source `17ed4b940a3050cf1f5377e1996b37a516734274`. Separate API release branches preserve each environment’s existing reliability implementation. Only additive migration `071_photo_interactions.sql` was applied. Production’s intentionally omitted historical migrations 052 and 057 remain omitted. Live schema fingerprints were verified and the canonical deployment records reconciled.

The continuity-aware release controller at `239292e225aaec8c655903ba40b1e63469dea633` enforced source/CI, schema, artifact, browser, session-continuity and rollback checks. Rollback-ready frontends retained both asset generations before the UI switches. Production API activation had 15 continuity samples; the final frontend activation had 16. Both had zero failed samples, successful post-command observations and zero remaining synthetic fixture rows.

## Automated evidence

- [Staging web/API CI](https://github.com/porchday/porchday/actions/runs/41961451833) and [production web/API CI](https://github.com/porchday/porchday/actions/runs/41961453430) passed, including database tests and photo tests against the preserved release schema.
- Exact production-source [iOS simulator verification](https://github.com/porchday/porchday/actions/runs/41961453524) and [macOS verification](https://github.com/porchday/porchday/actions/runs/41961453583) passed. The production gate verified their required successful steps and exact commit/run attempt. This includes the automated JavaScript/native cryptographic interoperability checks.
- [Release tooling CI](https://github.com/porchday/porchday/actions/runs/41961456786) passed. Its focused activation/parity tests also passed.
- Local browser checks covered 320/390/1200px photo-conversation rendering, draft retention and retry after failed saves, reaction replacement/removal and comment deletion. Old-tab/fresh-client asset transitions passed in both forward and rollback directions.

## Hosted acceptance

Staging and production ran the same synthetic-account browser/API scenario. An album read-only member added a comment through the real UI; the owner independently verified and decrypted its signed photo-audience envelope. The test verified reaction replacement, one current reaction per person, reaction removal, comment deletion, the distinct feed badge and denied conversation access after album revocation.

The scenario also verified existing-photo selection, older post-attachment adoption, unchanged original audiences, album refresh, mixed feed filters, calendar/navigation behavior, responsive rendering, and Share album preselection. All synthetic accounts and content were cleaned up through the owned-fixture procedure. A first staging probe asserted before an asynchronous save completed; its fixture was cleaned up, the probe was corrected to wait for the HTTP response, and the corrected probe passed on both environments.

Production login gates, old `/app` bookmarks, canonical `.org` navigation, `.com` redirects, legacy anonymous API access and installed-service-worker navigation passed. Independent monitoring after the final activation recorded eight healthy samples over 140,010 ms, with zero failures across login, logout, revocation, authorized feed/profile, anonymous sessions and protected readiness.

Private, owner-only deployment receipts retain schema fingerprints, source/artifact hashes, provider snapshots, browser evidence, synthetic cleanup and monitor results. They contain no public member-data report.

## Native availability and follow-ups

Shared iOS/macOS photo-conversation code is implemented and exact-source automated builds/tests passed. This release did not distribute a newly signed installer, TestFlight build or App Store binary. Hosted-native and physical-device acceptance remain honestly pending in the parity matrix and tracked in [#49](https://github.com/porchday/porchday/issues/49), [#114](https://github.com/porchday/porchday/issues/114) and [#7](https://github.com/porchday/porchday/issues/7). Under the owner’s updated policy they are follow-up verification, not web/API production prerequisites.
