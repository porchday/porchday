# Isolated session-denial progress release

This branch starts at deployed runtime `ebc567a4a0f66f72f2136a549ca28317e2419c84`.
Its application changes are limited to `session-denial-cleanup.ts`, the new
`session-denial-progress.ts`, and the operational-health integration. The change
is ported from `de7cfde` without importing development-only tracing or unrelated
application features. Schema, frontend, dependencies and Worker configuration
remain unchanged. Deployment is not implied by this source commit.

The v2 conditional progress record couples cursor advancement with page/full-pass
health. It preserves the old v1 cursor for rollback. Protected readiness reports
missing/unreadable progress, stale pages after three minutes, missing/stale full
passes after five minutes, passes taking over five minutes and invalid records.
Invalid-record health persists until a complete clean pass. Response fields are
aggregate-only; cursor/session IDs are not exposed. A two-second storage-read
bound does not hold the SQL health connection open. These operational limits do
not establish a maximum cleanup delay or the monthly availability objective.

Before activation with cleanup enabled, run the actual v2 sweep against the
intended environment under the deployment lease and verify a fresh clean full
pass. Never fabricate a completion timestamp. Pin runtime source, current schema,
existing public assets and reader-compatible rollback versions. After activation,
verify scheduled progress and hosted alert/recovery behavior. A rollback to v1
preserves denial enforcement but does not retain the new monitoring signal.
No immutable denial may be pruned to make a health check pass.

Local validation of this isolated tree: 20 crypto tests and 692 general tests
passed; 191 environment-dependent tests were skipped in the general run. All 38
auth-journal and restricted-session PostgreSQL tests passed separately using
disposable loopback databases, including native local R2 process-loss recovery.
API typecheck, formatting, secret and diff checks passed. Hosted CI, exact bundle
provenance, provider/configuration checks and staged rollout remain required.

Track implementation and deployment acceptance in issue #1 and PR #59.
