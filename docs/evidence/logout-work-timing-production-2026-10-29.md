# Production logout transaction diagnostics — October 29, 2026

Production version `048cd033-4855-4100-9fc2-d1d179fe398b` runs source
`a4d5a0f353e3703cf6b95a6dcafc0f2df9bd9340`, activated at 19:18:18 UTC.
The runtime change adds timing around existing transaction boundaries in two
files. Both candidate files and their baselines match the separately tested
staging patch. Schema, dependencies, assets, topology, authorization, journal
acknowledgement and mutation ordering are unchanged. Production writer and
cleanup bindings remain absent.

The exact source passed push verification 40934638895 and PR verification
40934649308. The diagnostic branch passed 895 PostgreSQL-backed tests and 22
crypto tests. Staging separately verified legacy logout/revocation, all six
successful transaction phases, compatible configuration restoration and cleanup.
[Staging evidence](logout-work-timing-staging-2026-10-29.md) retains the earlier
production-health preflight stop and its read-only reconciliation.

The maintained release controller verified an inactive upload before a separately
reviewed activation. All 15 continuity samples passed, including two after the
release command completed. An existing allowed session stayed available and a
revoked cookie stayed rejected. After activation, the remaining synthetic session
logged out with HTTP 200 in 3,015 ms and its old cookie returned 401. Exact fixture
cleanup left zero member, account, user and session rows. Provider state was
reconciled after cleanup and the deployment lease released.

Production telemetry subsequently contained all six successful transaction
subphases: acquisition, setup, identity lock, repeated authorization, handler and
commit. The pre-activation aggregate view contained none of these new phases.
The initial production sample reported acquisition rounded to zero, setup around
141 ms, repeated authorization around 368 ms and handler around 398 ms. These are
independently sampled aggregates with small observed counts; do not add them or
use them to reconstruct an individual request. They do not explain the prior
slowdown. No hosted rollback failure was injected; local failure tests cover
rollback timing and preserved commit ambiguity.

This rollout improves diagnosis. It does not demonstrate a latency correction,
regional availability or the monthly 99.99% target. [Issue #55](https://github.com/porchday/porchday/issues/55)
remains open. Read current aggregate phases and bounded correlated summaries
using the commands in [operational metrics](../operational-metrics.md).
