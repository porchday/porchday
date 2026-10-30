# Staging privacy commit reader floor — October 30, 2026

A reader-only staging deployment completed at 01:32:48 UTC. It retained runtime
`89f03970422e7869002703840b5067e5f585b11e`, enabled recovery, and kept
`PRIVACY_COMMIT_WRITER_V1` absent. No production deployment occurred.

## Verified transition

- Baseline reader: `54b93589-2197-4cd2-965e-f9c5823728ce`.
- Candidate reader: `fd35aa2e-f881-46fb-a596-e3d6eb7defb1`.
- Upload operation: `2e72d530-71f6-4f25-915c-1e609391e726`.
- Activation operation: `c82717c2-ffd0-4d89-a839-afd09178f2d1`.
- Controller and installed watcher: `a589e7a5fbcb7b7010da15e5ddcea0757e3bede4`.
- Canonical staging reader floor advanced from
  `8a4a9ae3-419c-4e49-8660-08d801a6fd15` to the candidate through the verified
  terminal receipt. It was not edited manually.
- Canonical schema metadata now records the verified 58 staging migrations,
  correcting the stale count of 56. Production's count remains 56.

All six exact-commit CI checks passed before execution: Verify Porchday
40985656576/40985649410, browser 40985656452/40985649402, and secret scan
40985656456/40985649429. Preparation verified the retained 54-file runtime
provenance, exact bindings, isolated queues, database schema, public assets and
both environments' six database routes and pooling configuration. The candidate
was verified inactive before activation.

The new prefixture check ran before creating owned synthetic accounts. The
maintained controller then observed allowed-session reads and revoked-cookie
rejection throughout activation: 11 samples, zero failures, two post-command
sample starts, and a maximum start gap of 2003.29 ms. The observer accepted only
the original canonical bytes or the exact durable finalization receipt, including
its schema proof and reviewed floor promotion.

Exact SQL cleanup verified zero remaining owned fixture rows. Temporary cookie
files and the retained fixture were removed; the deployment lease was released.
Provider inventory was reverified after cleanup. The frontend, production and
isolated cap-one queue configuration were preserved. Existing session-denial
writer/cleanup flags remain enabled in staging; these are distinct from the
privacy commit writer, which remains disabled.

## Independent watcher

The new immutable watcher package passed native startup without database
packages and read all 60 existing registrations and 56 completed archives without
invalid entries or canonical changes. The old process was stopped, its dedicated
SQLite lock checked, and the existing delivery database retained during handoff.
Two post-install polls had zero errors and pending alerts. After this activation,
the installed watcher reported 54 completed normal watches, seven delivered
historical alerts, zero waiting, zero pending and zero errors. The archive count
and normal-watch count differ because explicit historical failure alerts retain
their delivery status after recovery.

The PostgreSQL client now loads only for actual schema capture; pure receipt
validation does not require it. No new notification drill was sent during this
handoff, and owner inbox receipt remains unverified.

## Limits and next acceptance

This verifies successful reader deployment, durable floor advancement, canonical
schema reconciliation and fixture cleanup. It does not demonstrate an actual
rollback of this reader deployment or hosted marker-only crash recovery. Those
checks, writer activation, load/latency/cost acceptance and production rollout
remain outstanding. Preserve this operation's evidence; do not replay it.

Production remained at `048cd033-4855-4100-9fc2-d1d179fe398b`. Its independent
01:32:57 UTC probe was healthy, with no pending notifications. A successful
staging rehearsal does not establish monthly 99.99% availability, physical-device
compatibility, scheduled daily-release acceptance, or Mac power/network redundancy.
