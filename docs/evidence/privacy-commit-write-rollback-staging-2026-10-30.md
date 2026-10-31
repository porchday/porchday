# Session revocation on a writer candidate survives rollback

Hosted staging acceptance passed at **04:08:21.765 UTC on October 30, 2026**.
A normal session-revocation request committed on the active writer candidate.
The controller then rejected that candidate after an intentionally injected
browser exception and restored the reader baseline. Independent read-only
evidence proved the revocation's canonical marker and receipt after rollback.
Production was unchanged.

## Actual operation and rollback

Candidate `95676409-4214-4550-834e-af0bcfb63ec7` enabled the privacy commit writer
on executable `89f03970422e7869002703840b5067e5f585b11e`. The baseline was
`1400851f-25d3-4c6c-884b-c7c5710a8505`, with recovery enabled and that writer
absent. Schema remained at 58 migration entries. Frontend assets, denial
controls, isolated queues and consumer caps were unchanged. Retained reader
floor `fd35aa2e-f881-46fb-a596-e3d6eb7defb1` was not promoted.

Activation `e2c727b4-3708-46ab-af9c-511815ab4287` used the maintained staging API
recovery drill with its one-shot candidate action. After ordinary candidate
verification, the harness retained a durable request intent and dispatched
`POST /api/auth/revoke-sessions` once for its owned synthetic session. The
request returned HTTP 200 at 04:07:43.723 UTC in **3,299 ms**. Its cookie was
denied before the test browser fault was injected at 04:07:44.654 UTC.

The browser recorded the expected exception and failed candidate acceptance.
The old document and cold lazy module remained usable, with no old-tab errors;
the fresh login rendered with the one deliberately injected error. This fault
was confined to the observer. The controller verified rollback to the reader
baseline, followed by two healthy continuity samples.

At 04:08:15.171 UTC, a temporary native R2 bridge with read-only journal access
independently proved operation `94bf31a2-6921-4e6e-8b3d-c8c933d9766c`, sequence
`30723`: a fresh immutable intent inside the HTTP request window, matching
intent/scope hashes, a unique SQL commit fence, canonical marker ancestry,
ordinary receipt, retired pending intent, absent owned session, preserved
account and unchanged active journal generation. Nine native evidence reads
passed; the maximum took 169 ms. The observer did not publish a marker or
receipt, perform recovery, clear quarantine, or replay the request.

The candidate's revoked cookie remained denied after rollback and after proof.
The independent account stayed usable, and protected readiness passed after
proof. Temporary bridge teardown was verified before comparing final provider
inventory. The surviving account logged out normally; both exact synthetic
fixtures and private cookie/password files were removed, and the lease released.

## Continuity and admission

All **19 continuity samples** passed from 04:07:28.437 through 04:08:04.785 UTC,
including two post-command samples. Maximum durations were 601 ms for profile,
1,002 ms for feed, 698 ms for revoked-cookie denial and 873 ms for protected
readiness. Maximum sample start gap was 2,003.211 ms. The 10-second journey,
5-second continuity, 10-second evidence-read and 60-second audit budgets were
not increased.

All six source checks for runtime head `74851ab6a84fc750a26af585cd9bdd616c56b1a2`
and tooling `25cf4e4820808bb2a6f250f2e3dad2d612e73b64` passed. Admission included
38 resource checks, nine single-request harness cases, forward/rollback observer
tests, artifact provenance, pooling, native journal preflight and compatibility
with all 11 installed watcher modules. The one-shot hook separately passed its
focused controller and Chromium tests documented in PR #91.

The first read-only activation preparation was rejected because it supplied
22 references to each compatibility check, exceeding the existing limit of 20.
No controller activation or fixture write occurred in that attempt. A separate
immutable revision grouped all 22 distinct references by the checks they support,
preserved the failed preparation, retained the limit, and passed validation.
Private evidence is in
`artifacts/private/journal-commit-write-rollback-staging-20261030/`.

## Remaining scope

Staging finished on the reader baseline with the new writer upload inactive;
production remains `048cd033-4855-4100-9fc2-d1d179fe398b`. This test proves one
write during candidate verification survives the subsequent rollback. It does
not prove simultaneous auth mutations, an in-flight request spanning version
switching, credential changes, all auth paths, signed-in browser/native clients,
scheduled daily feature delivery, production writer admission or monthly 99.99%
availability. Those requirements remain open under #1 and #42.
