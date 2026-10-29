# Durable session revocation without a global unfinished operation

Status as of October 29, 2026, 08:43 UTC: denial readers and migration 056 are
deployed in staging and production. The request-scoped Better Auth hook covers
direct SDK calls, member and appeal middleware, prepared authentication and
endpoint-internal lookups. Web/native push checks denial through session-bound
preparation functions. The bounded cleanup sweep and separate queue path use
`SESSION_DENIAL_CLEANUP_V1`; the independent logout writer uses
`SESSION_DENIAL_WRITER_V1`. Both flags are enabled on staging version `7469d433` (runtime `992d24c`, including
v3 SQL candidate discovery and progress monitoring)
and remain disabled in production. [Hosted validation and remaining gates](../docs/session-denial-validation.md)
record normal logout, real identity-lock timeout, scheduled recovery, one hosted
revocation overlap and automatic compatible-version rollback with a retained SQL
row, with exact synthetic cleanup. Hosted interruption, remaining concurrency
orderings, device and capacity acceptance remain incomplete. This does not resolve #1, #55 or the 99.99% objective.
It is the first scoped application of a write-ahead denial model; other privacy
mutations retain the existing independent journal and quarantine behavior.

## Problem and proposed boundary

The current logout wrapper registers a global intent, runs SQL, checkpoints,
writes a receipt and removes the intent. A process can stop between those steps.
A missing completion receipt is genuinely ambiguous and must not be cleared by
elapsed time or a matching SQL cursor. Adding a SQL-only completion row does not
solve independent restore safety: that row can be rolled back with the mutation.

For a verified session logout, publish an immutable denial for that exact session
before attempting SQL deletion. Every consumer of that session must consult the
independent denial store. Once the denial is confirmed, an old SQL session row
cannot authorize access, even if cleanup fails or a SQL snapshot restores it.
This replaces global unfinished bookkeeping for this one operation with a
monotonic, narrowly scoped security decision. It is not permission to bypass the
existing global read guard or remove journal coverage from other mutations.

The current implementation in `apps/api/src/session-denial.ts` provides the
conditional immutable write, reconciliation after a lost acknowledgement,
exact-record lookup and a runtime reader. Hosted readers fail closed when the
recovery binding is missing; unbound development retains the existing journal
exception. There is no flag that disables reads of published denials. A two-second
read deadline includes the response body and fails closed. The private R2 binding
does not cancel a stalled read; its late completion cannot change the returned
verdict. This deadline does not apply to writes or prove a write failed. Hosted
latency acceptance remains required. Records contain the internal session UUID
so a future bounded sweep can delete the exact SQL row; they never contain bearer tokens,
cookies, email addresses or content. Keys use a domain-separated hash. The
caller must obtain the ID from verified server-side session authorization, never
from a request body. Each environment uses its own configured recovery bucket.

## State and failure behavior

| Boundary | Durable fact | Required behavior |
| --- | --- | --- |
| Before denial | None | Verify the exact caller-owned session and do not claim logout. |
| Write fails without a confirmed record | Outcome unknown | Return an error; never infer success or clear a global guard. A late durable write may safely deny the requested session. |
| Write reply lost, exact record readable | Session denied | Treat denial as confirmed without repeating the write. |
| Denial confirmed, Worker stops before SQL cleanup | Session denied | All guarded readers reject it; durable queue/sweep later removes the row. Other sessions remain eligible. |
| SQL deletion reply lost | Session still denied independently | Never replay the whole auth handler. Retry only the narrowly specified, idempotent cleanup. |
| SQL snapshot restores the row | Denial survives outside SQL | Readers and notification delivery still reject the session; existing restore quarantine and capability invalidation remain mandatory. |
| Denial lookup fails or is malformed | Authorization unknown | Fail closed for that check. Do not substitute cached permission or overwrite conflicting data. |

The storage test models SQL rows independently from the denial store. Additional
disposable PostgreSQL tests use the real auth SDK and restricted role to cover
missing bindings, failed reads, corrupt records, separate sessions and prepared
authentication. They leave a denied session row present, then delete and
recreate that row, verifying HTTP rejection and another
session's continued access. SDK and application auth-router checks also exercise
get-session, list-sessions, password changes, MFA enable, optional-session email
verification, and successful fresh credential login with the denied old cookie.
The SDK hook wraps only `findSession` in the request-local context, not the shared
adapter; it does not rewrite cookies or cache authorization. Multi-session is not
an enabled plugin and must not be enabled without auditing its separate bulk
lookup path. Cookie caching must remain disabled. Password reset, TOTP and
backup-code completion are tested locally with denied cookies and retained or
recreated SQL rows. Concurrency, live provider/device behavior and hosted failure
scenarios still require acceptance.
These tests are not a full database restoration drill. No production failure has
been induced for this design.

Push preparation returns a jobs-only envelope containing the internal session ID
and delivery subscription from the same SQL row. The original preparation
functions delegate to the new functions and retain their prior JSON shapes for
older Workers. No columns are dropped or changed. Apply migration 056 before
reader Workers; production currently has migrations only through 051, so the
isolated release must not accidentally deploy unrelated 052–055 work. All 23
web/native push tests passed both with the full development schema and with an
isolated local PostgreSQL 17 baseline of 000–051 plus only 056. Hosted migration
and rollback rehearsal remain rollout gates.

Both delivery paths consult the same bounded denial reader before constructing
or sending a provider request. A confirmed denial finishes that notification as
`failed`, leaving subscription cleanup to the separate durable cleanup protocol.
Missing bindings, failed reads, malformed records and deadlines retain the
existing bounded retry schedule; they never send. No internal session ID enters
the provider subscription/payload. Real PostgreSQL tests with injected provider
sends exercise independent denials while SQL rows remain present, other-session
delivery, storage recovery, role restrictions, wrong leases and legacy JSON
compatibility. These are not live provider or hosted deployment acceptance tests.

## Logout publication and acknowledgement

With the writer flag off, logout retains its existing global-journal path. With
`SESSION_DENIAL_WRITER_V1=true`, cleanup must also be enabled. Existing origin,
method/body, rate-limit and global privacy-read checks still apply. Authorization
captures the internal session ID from the SDK's verified lookup; request-body
member/session IDs never select the denial target. The writer then publishes the
immutable denial outside SQL locks, confirms the write or its exact persisted
record, and performs only that session's idempotent SQL cleanup. Success requires
confirmed SQL completion. Other privacy operations retain their existing journal.

Publication has a four-second deadline. A timeout or failed reconciliation returns
an error and does not start SQL cleanup. The underlying R2 write may still commit;
that late denial remains authoritative and the independent sweep discovers it.
A confirmed denial followed by SQL failure also returns an error, while guarded
readers reject the still-present SQL session. No global unfinished intent is
registered for this operation. A subsequent request with the denied old cookie
receives the existing unauthenticated response; fresh sign-in remains possible.

After confirmed SQL cleanup, a server-only SDK endpoint clears cookies using
Better Auth's own cookie definitions and chunk cleanup. It performs no further
SQL work after the initialized preflight and has no public HTTP route. It does
not replay the SDK sign-out handler. Cookie clearing alone is not a revocation
operation; only the authorized logout path invokes it after durable confirmation.
The writer requires the cleanup flag, but that is not proof of a deployed reader
floor: release tooling must still verify all active readers and compatible
rollback versions before either environment enables publication.

## Legacy history cleanup and operator recovery

The optional cleanup cron queues `session_denial_cleanup` separately from the
existing privacy-journal cleanup. The queue handler must continue excluding this
kind from the global intent wrapper. No queue message supplies deletion authority:
the legacy sweep discovers immutable denial records directly, validates canonical bytes
and their hashed key, and deletes only the exact independently denied session.
It obtains the current SQL owner, takes the existing identity advisory lock, then
deletes with both session ID and owner predicates. R2 reads/writes happen outside
that transaction. SQL statements have five-second server/lock limits and six-second
client read deadlines; failed clients are discarded. A lost commit acknowledgement
retries the same idempotent deletion, never an auth handler or a broader mutation.

Each legacy invocation visits at most ten records. The prior v1 cursor is
`session-denial-maintenance/v1/cursor.json`. The prior staging release used the separate
`session-denial-maintenance/v2/progress.json` record described below, leaving v1
untouched for compatible rollback. Its conditional write advances only after confirmed cleanup
and wraps at the end, so later inserts before an old cursor are discovered in a
subsequent pass. Competing workers cannot overwrite a newer cursor. Lost cursor
replies are safe whether or not the progress write committed. A corrupt denial
is counted and skipped without deleting its SQL row; valid records on later pages
continue processing. Missing/unreadable listed records or failed SQL stop the
page for retry. No denial object is deleted or expired.

Fixed metrics are `session_denial_cleanup_complete`,
`session_denial_cleanup_invalid`, and `session_denial_cleanup_retry`; no IDs or
provider errors are recorded. On retry, investigate independent storage and SQL
health. On invalid records, preserve private evidence and repair only through a
reviewed integrity investigation; never invent a denial or infer deletion authority
from a filename. A corrupt **v1** maintenance cursor may be conditionally reset to
`{"v":1,"cursor":null}` after preserving its evidence: this only repeats idempotent
cleanup. That operation must never touch `control.json` or the denial namespace.
Disabling cleanup stops SQL housekeeping, not denial enforcement. Retained records
and recurring sweeps increase reads with history size; capacity/cost and full-pass
latency still need measurement before writer activation. This cleanup does not
resolve ambiguous non-session privacy operations or guarantee cancellation of
requests authorized before denial publication.

## Independent denial-cleanup health (v2 historical implementation)

V2 writes cursor position and monitoring progress in one conditional update after
all valid records on a page have confirmed cleanup. It records page completion,
current-pass start/count/invalid count, and the last completed pass duration/count/
invalid count. Empty and single-page scans also write progress. CAS losers cannot
refresh another worker's heartbeat. Failed SQL does not advance progress; an
acknowledgement lost after a committed progress write still represents real work.
Invalid-record health persists through the following pass until a complete clean
pass is confirmed. The record is operational metadata, never denial authority.

Protected readiness reads this record only when cleanup is enabled. Its two-second
read deadline covers the body, and its database work runs concurrently so a stalled
R2 read does not retain the SQL connection. The response contains aggregate ages,
counts and fixed issue codes, without the cursor or session identifiers. Missing,
corrupt, unreadable or future-dated progress is not healthy. A page older than three
minutes is stale. A missing/older-than-five-minute full pass or a pass lasting more
than five minutes triggers a separate issue, even when pages remain fresh.
These are initial operational limits, not a demonstrated maximum cleanup delay:
new keys behind the cursor can require another pass, and growth/retries add delay.

V1 and v2 scan the same immutable prefix independently and perform idempotent SQL
cleanup. Starting v2 scans from the beginning; rolling back resumes the old v1
cursor without changing either denial enforcement or the v2 record. Old code does
not report the new health signal, so rollback must not be described as retaining
that monitoring improvement.

Rollout requires exact-source validation and a real successful v2 sweep under the
maintained deployment lease before readiness-gated activation with cleanup enabled.
Preserve the existing runtime/schema/assets and compatible reader floor; verify
that the scheduled deployed worker advances v2 afterward. Never seed or repair
health by fabricating a completion timestamp. An interrupted/unknown preparation
must be reconciled from actual progress and SQL evidence, not replayed blindly.
A corrupt v2 record requires a reviewed, evidence-preserving recovery that runs
actual cleanup; the v1 reset payload is invalid for v2. Hosted bootstrap, readiness-gated activation and scheduled page/full-pass progress
passed on staging on October 29. Stalled-job alert delivery, recovery, rollback of
this release and history-growth acceptance remain open. Production remains on the
prior runtime with both flags off.

The v2 sweep uses one progress GET and one CAS PUT per successful page, including
empty/single-page histories. Full-page worst-case operations remain one LIST,
eleven GETs and one PUT, excluding retries. Each enabled protected-readiness request
adds one progress GET; the 20-second external monitor alone adds 129,600 reads in
30 days. Other monitors and release probes add reads. Earlier one-page cost
measurements describe v1 and must not be presented as v2 billing estimates.

## Reader coverage required before any writer

The current source audit identifies these paths; final acceptance must also search for
new direct SQL consumers and new `createAuth` callers at the reviewed commit.

- `session.ts`: ordinary member and appeal authorization, including prepared auth,
  session refresh, native bearer adaptation and all downstream protected routes.
- `auth-routes.ts`: preflight and in-transaction authorization, recent-session/MFA
  checks, email-change callbacks, and every session-backed HTTP Better Auth
  endpoint (including get-session, list-sessions and verification-email sending).
  Cover library-internal session use as well as direct `api.getSession`. Preserve
  fresh credential/token authentication even when a request also carries an old
  denied session cookie; do not trap a logged-out member in a login failure loop.
- `social-push.ts` and `social-native-push.ts`: verify the session before an
  outbound send. Migration 056 returns the session ID with the checked
  subscription, and both consumers enforce the denial. Hosted lease/concurrency
  acceptance remains necessary; never send internal IDs to providers or logs.
- Any export, integration, WebSocket, staff or future capability path must be
  classified explicitly: session-backed capabilities require the guard; separately
  issued capabilities retain their existing revocation semantics. Do not assume
  that all bearer capabilities are the same session type.

No denial cache or positive authorization cache is introduced. Concurrent requests
already authorized before logout retain the existing transaction/identity-lock
ordering; the implementation must specify and test that boundary rather than
claim retroactive cancellation of an in-flight response or external delivery.

## Rollout and rollback barrier

1. Implement and deploy denial-aware readers with writers disabled. Verify every
   active backend and all applicable jobs. Record these as the minimum compatible
   rollback versions. Old application versions that ignore denials cannot be used
   once a denial may outlive its SQL cleanup.
2. Verify the versioned writer flag and logout-specific path before activation. Use a verified caller-owned session ID before publication; never hold a SQL
   transaction or identity lock across the R2 write. Publication only denies
   that immutable session ID, so a concurrent invalidation cannot broaden access.
   Preserve the existing identity-lock ordering for SQL cleanup and acknowledgement.
   Initially return an error if cleanup/drain is unconfirmed, while the independent
   denial keeps the old session unusable. Do not claim that publication alone
   cancels in-flight operations or satisfies the existing logout ordering. Keep
   other privacy operations unchanged.
3. Verify the implemented idempotent SQL cleanup and bounded persistent sweep. Queue delivery is an
   optimization, not the only discovery mechanism: process loss before queue send
   must not strand cleanup. Validate each object's exact ID/key relationship
   before deleting a row; malformed or unknown records are not cleanup authority.
4. Exercise staging crashes/lost replies at each boundary, concurrent logout and
   password/session operations, actual HTTP/SDK routes, browser and native paths,
   push preparation/delivery, old-session rejection and restored SQL snapshots.
5. Promote only after exact-source CI and hosted acceptance. Turning writers off
   stops new publications; it must never disable existing denial reads. Roll back
   to a verified reader-aware version, without resetting members' sessions or keys.

Do not prune these records yet. Retention, backup export, bucket migration and
restoration must preserve the namespace until an independently verified policy
proves a recorded session can never become valid again. R2 object lifecycle rules
or a seven-day session setting alone are not a pruning proof.

## SQL candidate discovery (staging deployed)

The history scan cannot remain the default indefinitely. At one logout every 20
seconds, the production monitor alone would create 4,320 immutable denials per
day after writers are enabled. Ten objects per minute would need at least 432
pages for that day's records alone, exceeding the five-minute full-pass gate.

`session-denial-candidates.ts` implements an alternative: page existing SQL
session IDs using the primary-key index, then consult each ID's canonical R2
denial before calling the existing identity-locked exact deletion. Completed
logouts with no SQL row consume no discovery reads, regardless of retained R2
history. Expired sessions are included. A restored or newly inserted row behind
the cursor is discovered on the next pass; the always-on denial readers continue
to reject it immediately. SQL is only candidate discovery, never denial authority.

Each page selects at most 100 sessions plus one lookahead row. SQL transactions
end before R2 reads; the auth role needs no new privileges or migration. At most
five authority reads run concurrently, each with a two-second deadline including
the body. Deletions run serially. The sweep stops starting work after 20 seconds
and checkpoints only completed candidates. An already-started SQL operation may
finish later under its existing query/lock deadlines; 20 seconds is not a hard
end-to-end timeout. Unknown SQL results do not advance progress. Invalid authority
is counted and skipped without deleting its session; health remains unhealthy
until a clean full pass completes.

Progress uses `session-denial-maintenance/v3/sql-sessions.json` with an explicit
SQL-discovery strategy. V1/v2 evidence is untouched. Local tests cover a 10,000
object history with only three candidate lookups, pagination, restored rows,
expired rows through the restricted PostgreSQL role, time-budget checkpoints,
late R2 reads, corruption, concurrent CAS winners, and lost SQL/progress replies.
The keyset query can use the existing primary-key index; the test does not claim
the production planner will always select that plan.

Read-only counts at 08:22 UTC on October 29 found 3 staging and 26 production
sessions, none expired. The actual candidate-list implementation then read both
environments through their auth roles without writes: one page each, 367 ms in
staging and 332 ms in production. These are single SQL-list observations, not R2
or full-sweep throughput. [Capacity evidence](../docs/evidence/session-denial-candidate-capacity-2026-10-29.json).
Counts can change and do not establish hosted throughput.
At these counts one 100-session page is sufficient if it completes within the
work budget. Large live-session populations still require measured full-pass
capacity; the strategy removes history growth, not all scaling limits.

Staging runtime `992d24c` selects this strategy for scheduled cleanup and protected
readiness together, retaining the existing cleanup enable flag. Disabled cleanup
reads no progress and creates no SQL pool. Missing v3 evidence cannot fall back
to fresh v2 evidence. Local subprocess tests now kill the writer after native R2
publication, then recover in a fresh process using SQL candidate discovery and
verify the denied session is removed while another session remains usable.

The isolated rollout passed on October 29: native-R2 scoped bootstrap completed a
real v2 pass to keep the initial rollback baseline fresh, then a v3 pass over three
SQL candidates in one second. Readiness-gated activation passed the synthetic
journey and all 29 assets. Five healthy observations confirmed a new scheduled
page and full pass within 43.005 seconds, without manual sweeps; that pass also
covered three sessions in one second, with no invalid records. All 48 bundled
first-party files matched the isolated Git source. No production change occurred.
[Hosted evidence](../docs/evidence/session-denial-candidate-staging-2026-10-29.json).
This is a small staging-population observation, not a larger-load guarantee.

A [hosted v3-compatible rollback rehearsal](../docs/evidence/session-denial-candidate-rollback-staging-2026-10-29.json)
subsequently passed with a retained denied SQL row and an unrelated usable member.
The controller rolled back after a local failed readiness observation; actual v3
health survived restoration, and scheduled cleanup removed the row within 45.343
seconds after lock release. This exercised a version/configuration transition with
identical application code, not every future feature migration or provider outage.

For a delayed legacy rollback, an old v2 binary reads v2 progress, which becomes stale if v2 scans stop. A late
rollback therefore needs an actual fresh v2 pass or an independently verified
compatible baseline; copying v3 timestamps into v2 would fabricate evidence.
Production writers remain disabled pending these and the other acceptance gates.

## Availability, cost and remaining scope

Normal logout should replace several shared-control writes with one write to a
unique session key, plus denial checks by consumers. This is a hypothesis to
measure, not an achieved latency improvement. R2 documents strong consistency for
[object reads and writes](https://developers.cloudflare.com/r2/reference/consistency/);
the implementation must use the private binding directly, without a CDN cache.
R2 remains a required dependency. Its unavailability still fails closed; this
change does not provide regional failover or eliminate Cloudflare as a failure
domain. No new service or paid commitment has been provisioned. Measure storage,
read/write usage and retention cost before enabling the writer.

Other privacy mutations, global control contention, SQL-independent completion
proof, durable recovery for ambiguous non-session operations, deployment rollback,
independent always-on monitoring, encrypted-write coverage and measured monthly
availability remain required work. Generalizing the approach requires a separate
scope/authorization proof for each decision type; never turn an arbitrary failed
mutation into an invented tombstone or replay it based only on elapsed time.
