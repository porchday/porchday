# Overlapping revocations survive staging rollback

Hosted acceptance passed at **04:32:44.817 UTC on October 30, 2026**. Two
distinct synthetic accounts sent overlapping normal session-revocation requests
on the writer candidate. Both completed successfully before a deliberate
browser acceptance failure caused automatic rollback. Independent read-only
proof afterward verified both canonical commits and ordinary receipts. A third
account remained usable. Production was unchanged.

## Deployment and requests

Candidate `4dc0c63d-d910-4606-bd52-5a5ab3845a81` enabled the privacy commit
writer on executable `89f03970422e7869002703840b5067e5f585b11e`. Activation
`ddb00e70-fc66-4769-8f68-f3e99f687267` returned to reader baseline
`1400851f-25d3-4c6c-884b-c7c5710a8505`. Both versions retain recovery support;
schema stayed at 58 migrations. Frontend, isolated queues, denial controls and
consumer caps were preserved. Retained reader floor
`fd35aa2e-f881-46fb-a596-e3d6eb7defb1` was not promoted.

The one-shot dispatcher fsynced exclusive batch and individual intents before
either POST. The requests started at 04:32:00.453 and 04:32:00.454 UTC and
returned HTTP 200 in **4,492 ms** and **3,207 ms**, respectively. Both cookies
then returned 401. Neither request was retried. The observer's deliberate fresh
browser exception was recorded at 04:32:05.789; verified rollback and two
post-command samples completed at 04:32:25.029.

At 04:32:36.976, the read-only native journal audit verified exactly two fresh
SQL fences and canonical markers, at sequences **30,726 and 30,727**, after
baseline 30,723. It verified original intent/scope hashes, ordinary receipts,
retired intents, absent owned sessions, preserved accounts, active generation,
non-quarantined SQL and unchanged journal control during proof. The audit made
18 journal reads and no database or journal writes. It did not manufacture
receipts, clear quarantine or replay either mutation.

Time-window matching was ambiguous. Commit scopes intentionally omit member
identity, so the result explicitly reports `perRequestIdentityProved: false`.
This establishes aggregate evidence for the controlled cohort; it does not
assign an individual marker to an account or prove simultaneous SQL execution.

## Continuity, cleanup and alerts

All **19 continuity samples** passed from 04:31:48.402 through
04:32:24.998 UTC, including two post-command samples. Maximum durations were
762 ms for profile, 1,062 ms for feed, 582 ms for revoked-cookie denial and
909 ms for protected readiness. Maximum start gap was 2,003.181 ms. Existing
10-second request, 5-second continuity and 60-second proof budgets were retained.

Both revoked cookies remained denied after rollback and after proof. The third
account remained usable and logged out normally. Protected health passed.
Temporary bridge teardown was verified before final provider comparison. All
three exact synthetic accounts and associated rows were verified absent; four
cookie files and the password-bearing fixture intent were removed. Final
provider inventory matched the controller's verified baseline and the lease
was released. Staging finished on the reader with the writer upload inactive;
production remained `048cd033-4855-4100-9fc2-d1d179fe398b`.

The Mac watcher published the owner-mention notification drill to
[release issue #3](https://github.com/porchday/porchday/issues/3#issuecomment-6515037609).
The remote comment names the exact activation and identifies itself as a drill.
Publication does not establish that an owner read an inbox notification.

## Admission and limits

All six CI checks for runtime head
`983f0f39f02e3615c498a7c4f69caa2d4f9880da` and tooling
`25cf4e4820808bb2a6f250f2e3dad2d612e73b64` passed before execution. Admission
included the 85 dispatcher/cohort/core-proof tests, nine wrapper cases, 38
resource checks, both continuity observers, artifact provenance, fresh native
journal preflight, database pooling and six runtime routes, plus compatibility
with all 11 installed watcher modules. Seventeen private rehearsal scripts were
pinned before execution. Evidence is retained under
`artifacts/private/journal-commit-cohort-rollback-staging-20261030/`.

This proves two overlapping client requests completed on the candidate and
survived subsequent rollback. It does not prove requests remaining in flight
across a version switch, arbitrary concurrency/load, successful credential
changes, all auth paths, signed-in/installed/native clients, scheduled daily
feature delivery, production writer admission or monthly 99.99% availability.
Those requirements remain open under #1 and #42.
