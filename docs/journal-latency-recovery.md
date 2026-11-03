# Journal latency and interrupted-operation recovery

This runbook describes the fenced journal protocol, its waiting budgets and release requirements. The [recovery issue](https://github.com/porchday/porchday/issues/1) records current deployment status, exact versions and acceptance evidence. A passing build alone is not production admission.

## Evidence and operating assumptions

Cloudflare's [R2 durability documentation](https://developers.cloudflare.com/r2/reference/durability/) distinguishes durability from availability and specifies a 99.9% availability SLA. Its [troubleshooting guide](https://developers.cloudflare.com/r2/platform/troubleshooting/) describes bucket-wide overload and recommends coordinated backoff. Neither these documents nor the reviewed [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) provides a maximum latency guarantee or a usable p99.99 bound for this application's journal operations.

The Workers API and installed workers-types definitions provide no AbortSignal on R2 get/put. A Promise deadline limits caller waiting; it does not cancel a remote write. Late writes retain their original immutable bytes and CAS preconditions. A timeout is never rollback evidence.

The November 3 incident established an approximately 120-second stalled control read followed by an R2 internal HTTP 500. The old retry budget began after that read failed. Concurrent age-based detection quarantined its pending operation. The incident is not an upper latency bound.

A production Analytics Engine sample from November 3, 17:00–18:20 UTC measured 559 read and 561 write phase records (weighted estimated counts 1691 and 1729). Weighted read p50/p95/p99 were 145/318/505 ms, maximum 683 ms; write values were 353/721/1107 ms, maximum 1607 ms. These phases include body consumption and retries. This healthy sampled window excludes the earlier outage and cannot establish worst-case provider latency. Private measurement evidence is retained under artifacts/private/journal-latency-20261103.

## Caller budgets and safety

The operating limits are five seconds per journal I/O and thirty seconds shared across the HTTP guard, registration, work and completion. Five seconds is roughly seven times the measured read maximum and three times the measured write maximum. It is a responsiveness budget, not an assumption that storage always responds within five seconds. Known transport failures retain bounded jittered retries, now counting the first failed attempt. Never-resolving calls and bodies are bounded; unresolved operations and user SQL work are not replayed. Deadline expiry closes the request's adapter, including late continuations.

Migration 070 prepares an operation in SQL before registering its pending R2 intent. Preparation expires after three minutes; expiry only permits attempting a durable terminal fence, never assuming rollback. Auth claim and finish occur in one transaction, enforced by a deferred constraint. Multi-step operations hold a shared admission lock in each SQL transaction; sealing takes an exclusive lock and prohibits future transactions. Earlier committed steps remain in the safety journal. Active SQL transactions use transaction/statement timeouts of thirty/ten seconds.

Recovery skips locked operations. Recognized active preparations return a temporary unavailable response without persistent quarantine. Expired abandoned preparations receive a committed terminal metadata marker under the exclusive lock. Recovery must export that marker and independently prove it in R2 before publishing a receipt and retiring the intent. Restored terminal markers also prevent an old preparation from reopening. Legacy unknown outcomes and integrity/restore failures retain their existing fail-closed behavior.

This bounds waiting and prevents a recoverable interruption from becoming permanent quarantine. Requests still fail safely while the required storage is unavailable; this change does not claim uninterrupted service during an R2 outage or guarantee 99.99% monthly availability.

## Validation and deployment gates

Local tests cover never-resolving lookup/body calls, late writes, aggregate deadline exhaustion, delayed event-loop timers, auth and multi-step SQL concurrency, lost registration replies, restore fences, role permissions, and SIGKILL at registration/commit/checkpoint/receipt/retirement boundaries. A multi-step SIGKILL test preserves its earlier commit and automatically seals the abandoned remainder. Application-clock advancement tests are deterministic protocol tests, not hosted ten-minute outage drills.

The recovery and writer switches are separate: JOURNAL_LATENCY_RECOVERY_V1 enables admission recovery; JOURNAL_LATENCY_WRITER_V1 enables new fenced registrations and bounded waiting. Reader-only rollout and writer rollback preserve legacy waiting behavior so deadlines cannot strand an unfenced legacy registration. The normal admitted configuration enables both. The writer requires latency recovery plus the existing privacy commit reader/writer. Configuration generation preserves explicit admission and rejects incompatible switches. Both new flags default off. Disabling the new writer must retain the new recovery reader. Old reader code cannot interpret the new multi-transaction scope, so advance the admitted reader/rollback floor before enabling writers.

The local PostgreSQL suite passed 38 tests, including process termination and restore fences; the auth suite passed 30 tests, including writer-disabled recovery. A native Worker/R2 check bounded a never-resolving lookup at 5.008 seconds while a concurrent request and a fresh recovery request succeeded. A full pre-admission dump/restore drill replayed 16 journal events and verified encrypted content, revoked access, media cleanup and terminal marker recovery.

The November 3 hosted staging drill withheld a successful registration reply for 210 seconds. The caller stopped waiting after 6.406 seconds overall, including preceding preparation steps. Both synthetic auth and multi-step preparations recovered through deployed requests after real SQL expiry, without changing clocks, manually clearing control state or calling a local recovery function. Five sampled health requests returned temporary 503 responses during uncertainty; the journal remained active throughout. Both receipts appeared and health returned to 200. After the late reply arrived, a delayed SQL claim was rejected. The complete observation took 212.839 seconds. This demonstrates automatic recovery, not uninterrupted success during the recovery interval.

Release procedure:

1. Require CI for the exact runtime source, source-verified bundles, atomic migration checks and a full restore drill. Apply additive migration 070 while existing code continues serving.
2. Deploy admission recovery with the new writer disabled. Verify allowed and revoked-session continuity, then record that compatible reader as the rollback minimum.
3. Enable the fenced writer and deadlines together. Exercise prolonged-response recovery in staging, then disable and re-enable the writer while preserving the recovery reader and rollback minimum.
4. Promote only after staging acceptance. Verify active production bindings, real SQL terminal admission and independent R2 marker/receipt proof, followed by full monitored user journeys. Record exact versions and evidence in issue #1 before reporting completion.

For an incident, inspect the active version and both latency flags. A deadline is an uncertain outcome: do not replay the original user action or clear its pending entry. Let fresh guarded requests recover once dependencies respond. Recognized active admissions can temporarily return 503; their expiry does not override an active SQL lock. Persistent integrity or restore quarantine still requires investigating its specific cause. Do not roll back below the admitted multi-step reader floor. Disabling the writer preserves recovery but temporarily restores legacy waiting behavior for new unfenced operations.

No destructive production fault injection is authorized.
