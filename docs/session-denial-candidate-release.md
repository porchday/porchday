# SQL candidate cleanup release

Prepared October 29, 2026; not deployed by this commit. This isolated source is
based on the staged v2 runtime. Runtime changes are limited to the new candidate
module and the scheduled-handler/operational-health imports. No migration,
dependency, frontend, denial-reader or writer change is included.

Scheduled cleanup and protected readiness use the same v3 SQL-session progress
record. Existing cleanup/writer enable flags are retained. Each candidate still
requires canonical immutable R2 authority before identity-locked exact deletion.
Expired/restored SQL sessions are included; immutable denial history is retained.
The v2 implementation and its evidence remain separate for rollback tooling.

Validation: 706 general tests and 20 crypto tests passed; 192 environment-dependent
tests skipped in the general run. Separately, 39 PostgreSQL auth/session tests and
14 queue-diagnostic tests passed. These include real identity-lock timeout,
publication finishing after its HTTP deadline, password/logout ordering, and a
writer killed after native local R2 publication followed by fresh-process
candidate cleanup. Typecheck, formatting, secret and diff checks passed.

Deployment requires a real v3 bootstrap, fresh protected readiness and scheduled
full-pass advancement. A rollback to v2 must account for v2 progress becoming stale
after its scheduler stops: use an actual fresh v2 pass before a delayed rollback,
never copy v3 timestamps. Verify a compatible v3 rollback baseline after rollout.
Staging throughput/rollback and remaining writer acceptance gates precede
production enablement. This source does not establish monthly availability.
