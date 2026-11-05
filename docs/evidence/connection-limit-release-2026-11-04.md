# 150-connection limit release — November 4, 2026

Owner request [#161](https://github.com/porchday/porchday/issues/161), implemented in [PR #162](https://github.com/porchday/porchday/pull/162).

The limit is now 150 accepted mutual connections, including family. Both endpoints must have capacity. Migration 072 changes normal acceptance and invitation-verification admission, preserving locking, idempotent retries, labels and history choices. Existing connections are retained even above 150. Removing connections restores capacity once below the cap. Album and group limits are unchanged.

Web counters, capacity controls, rules, API connection/bootstrap metadata and shared iOS/macOS views use 150. Native exact-source automated checks passed; signed native distribution and device verification remain separate under #49/#114.

## Deployed sources

- Frontend: `d91ba9db91d54829b4b52a18988917d50bba47d4`; production `dfe7f348-ecb7-46f3-ae1a-fe9df9259f44`, staging `baab26ca-b799-452f-9171-73feea6d1c96`.
- Production API: `c1594e92ab82d4c16d80db73db89ad511be78302`, version `438b23df-7b5f-42ae-a933-32ee916592f2`.
- Staging API: `bd0b2ed192f69c06c873ac174fa75069939a640d`, version `2684b817-87f7-4095-8df2-15b06a72d840`.

The API release branches preserve each environment's deployed runtime and change only the two connection-limit metadata values in application code. They also carry the migration, focused regression tests and current shared native client source. Unrelated backend changes from main were not included.

## Validation

- Local focused PostgreSQL suites: 57 tests passed, covering concurrent acceptance at 149, refusal when either endpoint is at 150, preserved over-cap relationships, idempotent retry, removal restoring capacity, and friend/family invitation verification.
- Member bootstrap: six tests passed. Connection browser controls: six scenarios each in Chromium and WebKit at 390px, including the 150-cap state.
- Full migration rehearsal confirmed that exactly two function definitions change from 300 to 150. Hosted migration/catalog verification confirmed the same change, preserved all other function definitions and columns, and recorded schema fingerprints.
- Exact-source full CI and iOS/macOS automated checks passed for frontend and both API release candidates.
- Staging and production checks verified API limits and the visible 150 counter. A bounded live SQL fixture accepted the 150th connection and rejected a 151st for either endpoint; the transaction was rolled back and its temporary members were confirmed absent.
- Existing feed, photos, comments/reactions, viewer, album/access-revocation, login, legacy-domain/root routes and PWA checks passed. Synthetic accounts and content were cleaned up.
- Production frontend activation: 15 continuity samples, 0 failures. Independent monitor: 8 healthy samples across 140 seconds. Final provider, schema, source and cleanup audit passed.

The staging migration initially stopped during catalog comparison because the database driver returned an array with extra metadata. Readback confirmed that only the two intended functions changed and all 523 columns were unchanged. The original committed migration was reconciled without replay; the production check normalizes catalog results before comparison. Follow-up remains under #3. The first staged boundary fixture also encountered an unavailable role switch and rolled back. The final hosted test calls the existing SECURITY DEFINER entry points without changing privileges; restricted-runtime-role behavior is covered by the local and CI database suite.

Release tooling: `239292e225aaec8c655903ba40b1e63469dea633`, including native parity enforcement and the complete live queue inventory. Private proofs and credentials are excluded from this document.
