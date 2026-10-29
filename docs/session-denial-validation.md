# Independent session denial: validation gates

The logout writer and cleanup flags are enabled on staging as of October 29,
2026, 07:05 UTC, and remain disabled in production. The scoped staging rehearsal
below passed; production enablement remains gated.
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

## Local process-loss acceptance — October 29, 2026

The restricted-session PostgreSQL suite now runs a real subprocess publishing the
production denial helper into native local R2 over a test-only loopback adapter.
After the helper confirms publication, the parent kills the writer with `SIGKILL`
before any cleanup connection exists. The SQL row remains present, but a fresh
SDK session check rejects the denied cookie and accepts an unrelated session.

A separate subprocess runs the production sweep and exact deletion using the
restricted auth database connection. It deletes one session; another fresh process
repeats the sweep and deletes zero. The test verifies one publication, retention of
the canonical denial, and unchanged global control. All 14 restricted-session
integration tests passed. The R2 service stays alive independently of the killed
client, matching the relevant process-loss boundary. This is local native-R2 and
PostgreSQL evidence, not a hosted Worker kill, a storage outage, or a complete
HTTP-request process-kill test. Hosted writer and device gates remain open.

## Integration with current main

The denial branch incorporates main through `ae1d631`, including the confirmed
pre-COMMIT rollback fix and maintained release activation/recovery tooling. The
merge retains `commitAttempted` tracking: only an acknowledged rollback before a
COMMIT attempt proves non-commit; unknown commit and rollback outcomes remain
unresolved. The combined real-PostgreSQL auth-journal and restricted-session suites
passed 36 tests after integration.

This source integration is not deployment authorization for every feature on main.
Compared with the verified live runtime `ebc567a4`, the merged tree also contains
migration 052 and additional application/UI changes not present in that deployment.
A hosted writer rehearsal must pin the actual runtime, asset manifest, schema and
compatible-reader rollback floor, preserve existing deployment settings, and avoid
silently bundling those unrelated features. Writer/cleanup flags remain disabled
until their acceptance gates are met. Reconcile provider state against the canonical
record immediately before any change; this document does not override newer state.

## Capacity and cost checkpoint — October 29, 2026

[Measurements and scoped hosted inventory](evidence/session-denial-capacity-2026-10-29.json)
show three retained records / 246 bytes in staging and one / 82 bytes in production.
Both buckets report Standard storage. Both deployed schedules include the
one-minute cron; the daily backup cron does not enqueue denial cleanup. Inventory
read metadata only, did not read denial bodies or mutate the namespace, and verified
removal of the temporary operators and unchanged application configuration.

Native local R2 measurements of the production sweep:

| Retained records | Pages per full pass | GETs per pass | LISTs / cursor PUTs | Nominal full-pass minutes |
| --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 1 / 0 | 1 |
| 10 | 1 | 11 | 1 / 0 | 1 |
| 11 | 2 | 13 | 2 / 2 | 2 |
| 100 | 10 | 110 | 10 / 10 | 10 |
| 1,000 | 100 | 1,100 | 100 / 100 | 100 |

The test counts cleanup callbacks; it does not measure hosted SQL or queue latency.
The minute column assumes uninterrupted one-minute scheduling, no retries and a
stable record set. A new key behind the cursor may wait for the scan to wrap.
Immediate reader denial is independent of this SQL-cleanup delay. Missed schedules,
retrying pages and continuous growth can increase discovery time.

For 30 days at one successful page per minute, the sweep executes 43,200 pages.
With full pages, it uses at most 86,400 Class A operations (LIST plus cursor PUT),
475,200 Class B GETs, and 432,000 cleanup callbacks. Each already-absent SQL session
still costs five statements, yielding up to 2,160,000 SQL statements in this model.
Current one-page histories require no cursor writes and fewer GETs/callbacks.
Retries and duplicate queue deliveries are additional work, not included limits.

Cloudflare's Standard rates checked October 29 are $0.015/GB-month, $4.50/million
Class A operations and $0.36/million Class B operations. LIST/PUT are Class A;
GET is Class B. Included monthly usage is 10 GB-month, one million A and ten million
B operations; billing rounds to whole units. These allowances are shared with other
account usage. [Official pricing](https://developers.cloudflare.com/r2/pricing/).

The modeled full-page sweep is $0.559872/month at unrounded operation rates before
shared allowances. This is a marginal usage estimate, not an invoice or spending
cap. Add one Class A publication per logout, authorization denial GETs per verified
session lookup, retries, Worker/Queue/database usage and storage. One million retained
canonical records contain about 82 MB of body data; no retention pruning is enabled.
Account-wide billing and non-R2 costs have not been verified here.

The current four-record inventory fits one page per environment. This supports a
bounded staging rehearsal, not unlimited production growth or a cost guarantee.
Before wider writer rollout, measure hosted sweep latency and concurrent traffic;
set an operational history/backlog threshold and demonstrate cleanup discovery
within the chosen bound. Historical rechecks and full-pass delay remain scaling
work tracked in #1. Never expire authoritative denials to solve that problem.

## Hosted staging writer and scheduled recovery — October 29, 2026

[Hosted evidence](evidence/session-denial-writer-staging-2026-10-29.json) records
staging version `57a5c9f2-7d32-447c-bad8-2fc6130163c1`, runtime `ebc567a4`,
with `SESSION_DENIAL_WRITER_V1` and `SESSION_DENIAL_CLEANUP_V1` enabled. Production
retains version `3ee85699-feef-4b0c-b264-d5ff13ab6e94` with both flags disabled.

The maintained inactive-upload and activation commands verified exact executable
and map provenance, unchanged schema and 29 retained public assets. Only the two
staging plain-text flags changed. The dry run caught an overriding metadata block
that initially omitted the flags; the corrected candidate was verified before
upload. Exact runtime/tooling CI passed. Activation completed its synthetic journey
and durable finalization; historical resume reports already finalized.

Two new synthetic members exercised normal logout and an identity-lock timeout.
Normal logout returned 200 in 709 ms, cleared the SDK session cookie, persisted the
canonical denial and removed its exact SQL row. A separate login was then logged
out while its member identity lock was held. The route returned 503, its SQL row
remained, and its cookie was rejected while the other member could still read their
profile. After lock release, polling observed the existing scheduled cleanup remove the
denied row within 25.224 seconds (five-second polling), without a manually
dispatched sweep or deletion. Global privacy
control was active with no pending intents.

An initial verification read through the REST adapter lacked a usable strong ETag.
The completed logout was not repeated. A scoped read-only temporary native-R2
operator reconciled the exact immutable bytes, and the SQL state was checked before
continuing. The strict REST adapter was not weakened. All synthetic accounts and
sessions were removed; their immutable denials remain. Temporary operator removal,
unchanged application state during acceptance, and released deployment lease were
verified. Final staging readiness returned 200/healthy and production monitoring
remained healthy.

This proves the normal hosted writer and one real lock-contention/scheduled-recovery
path. Hosted lost replies, late publication/Worker termination, concurrent password
and session changes, rollback with an uncleaned denial, physical devices and larger
history bounds remain separate gates. Staging enablement is not production
acceptance or evidence that the monthly availability objective has been achieved.
