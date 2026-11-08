# Posting while a connection finishes encryption setup

Released November 8, 2026. [PR #186](https://github.com/porchday/porchday/pull/186), [issue #185](https://github.com/porchday/porchday/issues/185).

Social posts and their attachments now encrypt to every ready eligible device instead of blocking on an accepted connection without keys. Pending direct-connection eligibility is recorded against the existing connection, including future-only connections present when the post was published. The metadata contains no plaintext or keys and grants no read access. After recipient setup, the author’s unlocked app performs encrypted catch-up. Another keyless member does not block that delivery. The composer explains this timing.

The exact ready-recipient set, device fingerprints, epoch, author, expiry and current audience checks remain enforced. Blocking, connection deletion and relabeling remove pending eligibility. Newly added future-only connections do not gain earlier content. Community and Extended family retain their existing graph-derived history rules. Album/admin and standalone-photo snapshot policies are unchanged.

Migration 076 is additive and compatible with the previous API. The environment-specific auth/session runtimes are preserved; this release changes only the scoped API envelope check, pending metadata migration and regression test relative to each deployed API.

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API | `5fec1df4607f2e27a22911cdda8e3764f5ece4aa` | `3dfee2ef-e5ea-4493-9b6d-b42642313ba7` |
| staging | Frontend | `ff500bf52caeb36ea542551c91767699a5dabf23` | `838ddc60-f293-4a6f-9ee0-304d873ff4fb` |
| production | API | `4c2c85d9fd97a74b1f50aaa56248d3b15985f0a4` | `f1385fc2-c8b7-4087-ba21-ea4efaa50098` |
| production | Frontend | `ff500bf52caeb36ea542551c91767699a5dabf23` | `76c4c1db-9204-4df6-8aa8-ddc9813a6b96` |

## Verification

- 29 real-OpenPGP HTTP tests and 331 web tests passed, along with workspace typechecks and Chromium composer/calendar checks. The four-photo regression also passed against both preserved API runtimes.
- Hosted exact-source web/API, secret-scan, iOS simulator and macOS checks passed for frontend and API candidates.
- Staging and production synthetic-account tests published four photos with two keyless future-only connections. The ready friend could read immediately; the keyless friend had no grant. Real initial device registration enabled author-signed catch-up and successful decryption of the post and all four photos while the other member remained keyless. Block/disconnect checks passed. Synthetic account, post, media and pending rows were removed; encrypted object deletion was durably scheduled.
- Authenticated session continuity, revoked-session denial, canonical login/routes, simulated native bridge smoke, exact deployed asset hashes and forward/rollback open-tab compatibility passed.
- Final audit: `2026-11-08T21:20:29.673Z`. Production monitoring observed 8 samples over 140011 ms with zero failed samples.

The installed default web shells receive this shared UI update without a new TestFlight installation (iOS 247 and macOS 236 remain the available builds). Legacy Swift vault/history source was updated and tested, but no new signed binary is claimed. Physical-device acceptance remains separately tracked in #49 and #114; the live checks above are not physical WKWebView tests.

Existing tabs must load the new web bundle to use the fix. Preserve an unsent text/photo draft before reloading. Catch-up requires the author to open the unlocked app after the recipient completes setup; it is not server-side decryption or immediate delivery while the author is offline.
