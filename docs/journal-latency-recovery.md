# Journal latency recovery — implementation in progress

This work is not yet deployed or admitted for production. The previously deployed commit-marker reader/writer remains active. Do not deploy the deadline change by itself: bounded waiting exposes the abandoned-registration window described below.

## Evidence and operating assumptions

Cloudflare's [R2 durability documentation](https://developers.cloudflare.com/r2/reference/durability/) distinguishes durability from availability and specifies a 99.9% availability SLA. Its [troubleshooting guide](https://developers.cloudflare.com/r2/platform/troubleshooting/) describes bucket-wide effects of overload and recommends coordinated backoff. Neither these documents nor the reviewed [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) provides a maximum latency guarantee or a usable p99.99 bound for this application's journal operations.

The Workers API and the installed workers-types definitions provide no AbortSignal on R2 get/put. A local Promise deadline therefore limits caller waiting; it does not cancel a remote write. Late writes must remain subject to the original immutable bytes and CAS preconditions. A timeout is never rollback evidence.

The November 3 incident established an approximately 120-second stalled control read followed by an R2 internal HTTP 500. That is an observed incident, not an upper bound. Recovery must work after much longer delays without guessing an absent commit from elapsed time.

## Implemented locally

`journal-deadline.ts` bounds initial lookup, body consumption, and subsequent I/O with a shared monotonic deadline. Once a deadline expires the whole adapter closes. A late lookup cannot start a body read; a late completion cannot initiate another write. Pending promise rejections are observed. An uncertain timed-out operation is not retried within that adapter.

The current development parameters are 5 seconds per I/O attempt and 30 seconds per adapter scope. These are provisional caller budgets, not provider latency promises, a recovery horizon, or a final production admission decision. Known transport failures retain bounded jittered retries; their budget now includes the first failing attempt rather than starting after it returns. Database operations in this adapter are reads only. User SQL work is never retried here.

Twenty-three focused tests pass, including late successful writes, initial calls that never resolve, stalled body reads, a delayed event-loop timer, aggregate deadline exhaustion, and concurrent calls. API type checking passes. These tests do not prove the protocol changes below or production readiness.

## Required protocol work and deployment gates

1. Registration currently precedes auth scope publication and SQL work. A late successful registration or a crash before SQL begins can leave an old pending intent without a commit marker. A durable preparation/transaction fence must distinguish abandoned work from work that can still commit. A database row's absence or age alone is insufficient evidence, especially across restore.
2. Bind transaction admission, terminal commit/abort proof, independent journal evidence, and replay behavior. Recovery must prevent a delayed worker from starting or committing after cancellation. Preserve existing legacy and multi-transaction route guarantees; do not reinterpret their unknown outcomes as harmless.
3. Separate transient storage unavailability from corruption, rollback, and operator quarantine. A storage timeout must not persistently quarantine the service. Genuine unresolved privacy outcomes remain protected until sufficient durable proof exists.
4. Ensure the whole HTTP journal lifecycle shares an appropriate waiting budget, with fresh bounded recovery attempts after storage returns. Select final caller and recovery budgets using application measurements; support interruptions beyond any selected grace period through protocol evidence.
5. Exercise all preparation, commit, receipt, and retirement interruption windows, late responses, concurrency, and restore in deterministic and real database tests. Perform safe hosted staging recovery and rollback drills before deployment.
6. Deploy compatible readers before writers/schema-dependent behavior, pin the rollback floor, verify real production proof and full user journeys, and update issue #1 and the restore runbook. No destructive production fault injection is authorized.

## Admission implementation checkpoint

Migration 070 now implements auth preparation before pending registration. Auth work claims the admission row inside its own SQL transaction; a deferred constraint prevents committing a claim without its terminal marker. Expiry is currently three minutes and is an admission deadline, not permission to assume rollback. Recovery uses `FOR UPDATE SKIP LOCKED`: a running transaction cannot be abandoned, and an abandoned preparation cannot subsequently be claimed. The existing canonical commit-marker format carries the terminal metadata transaction, including an empty transaction that fences work which never began. Recovery still must export and prove that marker in R2 before retiring the intent.

Local PostgreSQL tests cover expired preparation, lost registration replies, running transactions past admission expiry, acknowledged rollback, and an application clock advanced by ten minutes. The latter is a deterministic protocol test, not a ten-minute hosted outage drill. Twenty-four SQL integration tests and 51 focused deadline/proof/I/O tests pass. Auth runtime wiring uses the new `JOURNAL_LATENCY_RECOVERY_V1` flag, currently absent from deployed configurations. Deadline behavior remains disabled in runtime unless that flag is explicitly enabled.

Remaining before admission: extend preparation and transaction fencing to generic/multi-transaction journal callbacks, share the request waiting budget across guard and work resources, select budgets from measured R2 latency, exercise process termination and late responses with the new admission protocol, verify restore and permission coverage, run hosted staging interruption/rollback checks, and deploy/verify production. The generic-path gap is not waived by the auth tests.
