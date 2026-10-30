# Auth commit recovery reader: staging rollout

Accepted on 2026-10-30 at 01:08:06 UTC for #1 and #42, draft PR #92.
Runtime source: `89f03970422e7869002703840b5067e5f585b11e`.
Staging backend version: `54b93589-2197-4cd2-965e-f9c5823728ce`.
Previous backend: `0d333719-a457-40a5-94a2-8ee4a2371ded`.

Migration 057 was applied to staging before activation, bringing its ledger to
58 entries. Exact function bodies, search paths, role grants, fence RLS and
schema fingerprint were verified. The first metadata check incorrectly treated
PostgreSQL array text as a JavaScript array with type discovery disabled.
The acknowledged SQL commit was reconciled with read-only database-side
comparisons; it was never replayed.

All six exact-source CI checks passed, including the real pre-057 backup drill.
The packaged Worker matched 54 immutable first-party source files. The inactive
upload was verified before activation. Its only new binding enables
`PRIVACY_COMMIT_RECOVERY_V1`; `PRIVACY_COMMIT_WRITER_V1` remains absent.
Existing denial reader/writer/cleanup settings, isolated queues and all four
single-consumer concurrency caps were retained.

The first activation plan was rejected by the release lease before dispatch
because it omitted acknowledgement of the canonical denial-reader floor.
No activation journal or provider activation was created. Its two synthetic
accounts were cleaned up exactly, and the original backend remained active.
A separate reviewed activation reused the verified inactive upload, acknowledged
the existing floor, and retained the exact previous backend as its rollback
target. The original rejected operation was not retried.

The successful activation ran authenticated continuity checks using fresh owned
accounts: an existing allowed session, a revoked cookie, and operational health.
All 11 samples passed, including two started after the command completed; the
maximum sample-start gap was 2,002.1 ms. Revoked cookies stayed rejected across
the change. The candidate passed the maintained journey checks. Final fixture
rows were zero, temporary cookies were removed, provider state was reconciled
after cleanup, and the release lease was released.

The staging frontend remains `89eec37f-e097-4e65-9b71-42ad08d854de` with retained
assets. Production remains `048cd033-4855-4100-9fc2-d1d179fe398b` with neither
commit-protocol flag enabled. The external production probe stayed healthy.

This proves the reader rollout passed its sampled continuity checks. It does
not prove hosted crash recovery, actual rollback of this candidate, physical
native-device behavior, high-load latency, or monthly 99.99% availability.
Those gates remain open before writer enablement or a production rollout.
