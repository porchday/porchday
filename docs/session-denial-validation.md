# Independent session denial: validation gates

The logout writer and cleanup flags remain disabled in staging and production.
Reader enforcement has hosted API evidence and a scoped staging push rehearsal.
Writer and cleanup interruption cases, concurrent behavior, device behavior and
storage-cost acceptance remain open. This work must not weaken the independent privacy journal
or silently treat an unknown commit as complete. Track #1 and #55.

## Scoped push verification

`deliverWebPush` and `deliverNativePush` contain the same per-delivery denial and
provider-outcome logic used by the normal queue workers. They do not claim jobs,
finish jobs or open a database connection. Their `delivery` argument must be the
session/subscription envelope returned by the corresponding jobs-role
`app.prepare_*_delivery` function under a valid job lease. A caller-provided session
ID alone does not establish subscription or notification authorization. Native
provider credentials are supplied by the normal worker's existing token path.
These are internal functions, not HTTP endpoints or new authorization bypasses.

Local acceptance covers:

- Native workerd execution with an actual local R2 binding: a canonical denial
  suppresses both web/native sends; an independent session reaches only intercepted
  provider transports. Unreadable denial authority causes retry with no send.
- Missing, conflicting, failed and late denial reads. A late read cannot authorize
  a send after its deadline has already produced an unknown result.
- Existing provider redirect/retry behavior and the unchanged normal queue path.
  Both existing SQL suites run against newly created, task-owned disposable local
  databases, including restricted-role preparation and retained SQL session rows.

These are local checks. Provider sends are intercepted; they do not prove hosted
push delivery or physical-device behavior.

Before a hosted enforcement rehearsal, prepare an owner-only manifest listing the
exact synthetic identities, sessions, subscriptions, notifications and outbox jobs,
with source/schema/provider pins and a cleanup ledger. Obtain delivery envelopes
through the real jobs-role preparation functions using only those fixture job
leases. Do not call the shared `claim_push(20)` or `claim_native_push(20)` functions
merely to obtain test work: they can select unrelated notifications.

Use a temporary authenticated operator bound to the intended environment's R2
journal, running the pinned per-delivery helpers. Intercept all provider sends and
return only aggregate outcomes/counts. Verify denied, permitted and unavailable
cases; confirm unrelated session access remains usable. Preserve uncertain writes
for read-only reconciliation. Keep canonical immutable denial objects; scope SQL
cleanup to the manifest and verify it before removing the operator. Do not enable
writer/cleanup flags from this one check: the remaining failure, concurrency,
rollback-reader, device and cost gates are separate requirements.

## Hosted staging push rehearsal — October 29, 2026

[Sanitized evidence](evidence/session-denial-push-staging-2026-10-29.json) records
six successful hosted cases using helpers from source `832b182`. Web and native
push each suppressed a denied session, allowed an independent session through an
intercepted provider transport, and retried without sending when denial authority
was unavailable. Both SQL session rows remained present during enforcement.

Two synthetic members supplied four delivery envelopes through the existing
staging jobs connection and `app.prepare_*_delivery` functions. The migration
connection could not switch to the jobs role; the rehearsal stopped, reconciled
the committed fixture by exact IDs, and continued with the dedicated jobs
connection. It did not repeat fixture creation. Synthetic outbox jobs were held
with `next_retry = 'infinity'` inside their creation transaction, so a process
interruption could not expose them to background claimers. No shared queue claim
function was called in staging.

The expiring, authenticated temporary operator accepted only the pinned synthetic
session/subscription envelopes and one immutable denial record. Native workerd
scope checks passed locally before upload. All provider sends were intercepted;
there were zero actual provider requests. Exact fixture cleanup, operator removal,
and unchanged provider deployment/configuration snapshots were verified. The
canonical denial record remains immutable. Production runtime and the disabled
writer/cleanup flags were unchanged.

This completes the scoped hosted push-enforcement check. It does not demonstrate
physical-device delivery, a production queue end-to-end test, writer/cleanup
interruption recovery, or the monthly availability objective.

## Local logout-route interruption checks — October 29, 2026

The real Hono logout route and restricted PostgreSQL auth connection now cover a
write committing after the four-second publication deadline and cleanup timing out
behind an actual PostgreSQL identity advisory lock. The full auth-journal suite
passed 18 tests against a newly created loopback database, removed afterward.

In the late-write case, the HTTP response is 503 and SQL remains untouched. Once
the immutable denial commits, the old cookie becomes anonymous while the separate
member remains authenticated. The expired HTTP path does not resume cleanup or
repeat publication. The independent sweep deletes the exact session once, then
returns zero deletions on another pass. The global control record stays unchanged.

In the lock-contention case, publication succeeds but SQL cleanup fails within its
configured timeout. The retained SQL row cannot authorize the denied cookie, the
separate member remains authenticated, and releasing the lock permits sweep
recovery. Global control again stays unchanged. These tests exercise real SQL and
HTTP route behavior with an injected in-memory denial store; they do not establish
hosted writer behavior, process-crash durability, or device acceptance.
