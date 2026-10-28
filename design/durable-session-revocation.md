# Durable session revocation without a global unfinished operation

Status: design and storage primitive only. No live reader, writer, cleanup job or
rollout flag is connected. This does not resolve #1, #55 or the 99.99% objective.
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

The current implementation in `apps/api/src/session-denial.ts` provides only the
conditional immutable write, reconciliation after a lost acknowledgement, and
exact-record lookup. Records contain the internal session UUID so a future
bounded sweep can delete the exact SQL row; they never contain bearer tokens,
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

The storage test models SQL rows independently from the denial store. It is not
an HTTP, database, push-provider, hosted-failure or restore acceptance test.
No production failure has been induced for this design.

## Reader coverage required before any writer

The current source audit identifies these paths; integration must also search for
new direct SQL consumers and new `createAuth` callers at the reviewed commit.

- `session.ts`: ordinary member and appeal authorization, including prepared auth,
  session refresh, native bearer adaptation and all downstream protected routes.
- `auth-routes.ts`: preflight and in-transaction authorization, recent-session/MFA
  checks, email-change callbacks, and the HTTP Better Auth handler's get-session
  response. Cover library-internal session use as well as direct `api.getSession`.
- `social-push.ts` and `social-native-push.ts`: verify the session before an
  outbound send. Their SQL preparation routines currently decide eligibility
  from database state, so API-only integration would be insufficient. Expose the
  required internal session ID through a narrowly scoped, compatible query or
  function; never send it to push providers or public logs.
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
2. Add a versioned writer flag and the logout-specific path. Use a verified caller-owned session ID before publication; never hold a SQL
   transaction or identity lock across the R2 write. Publication only denies
   that immutable session ID, so a concurrent invalidation cannot broaden access.
   Preserve the existing identity-lock ordering for SQL cleanup and acknowledgement.
   Initially return an error if cleanup/drain is unconfirmed, while the independent
   denial keeps the old session unusable. Do not claim that publication alone
   cancels in-flight operations or satisfies the existing logout ordering. Keep
   other privacy operations unchanged.
3. Add idempotent SQL cleanup and a bounded persistent sweep. Queue delivery is an
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
