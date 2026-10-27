# Availability objective: 99.9%

Porchday's availability objective is **99.9% over a rolling 30 days**. This is a target to demonstrate, not an achieved result or a contractual SLA. A working homepage is insufficient: people must be able to sign in, read their authorized feed, and perform core social actions. The October 27 production quarantine counts as an outage, even though `/health` returned 200.

Thirty days contain 43,200 minutes. The downtime budget is **43 minutes 12 seconds**. Planned maintenance, deploy-related failures and privacy-quarantine outages count. Missing monitoring is unknown, never silently healthy. Recovery does not reset the error-budget history.

## Measurement and response

- Record one-minute protected readiness checks, including failed checks before the alert threshold and gaps in observations. Retain at least 30 days of timestamped aggregate outcomes. Publish coverage and collection start alongside any percentage; do not invent older observations.
- Add authenticated synthetic journeys from two independent US locations outside Cloudflare: login, feed, create/read/delete synthetic posts and comments, and logout/revocation. Use isolated identities and encrypted synthetic payloads, never real-member accounts. Separate mail-delivery checks from synthetic reads. A 200 shell or anonymous session response does not certify these journeys.
- Track request availability per core route: successful eligible requests divided by all eligible requests. Count 5xx, timeouts, unintended 429 and incorrect outcomes; exclude expected authentication/validation rejections. Report sampled aggregate metrics as estimates. Static asset traffic must not hide a broken login or write route.
- Page after three consecutive failed minute checks; target acknowledgment within five minutes and ordinary interruption recovery within ten minutes. These are response objectives to rehearse, not guarantees. Verify a backup operator and an alert channel outside Cloudflare. Disaster recovery has separate RPO/RTO requirements.
- When the 30-day error budget is exhausted, stop feature/topology promotions. Permit reviewed reliability, security and recovery changes through staging. Release serialization, exact-source CI, provider-state reconciliation and rollback checks remain required. Never relax authorization, expiry, encryption or revocation to improve the number.
- Review incidents, causes and budget consumption weekly. Claim 99.9% only after a complete measured window meets the target, with core-journey and regional coverage disclosed. A short healthy smoke test cannot establish this.

## Immediate correction: temporary journal I/O failure

The runtime journal has a bounded shared retry budget for read-only safety queries and R2 operations. It retries only allowlisted database connection/capacity failures. R2 writes are eligible only with an existing conditional precondition and retain the same key, bytes and precondition across attempts. An uncertain successful write becomes a precondition miss; the existing protocol reads current state and proves the result. User actions, SQL mutations, email sends and safety decisions are never replayed by this adapter.

There are at most three retries across one runtime journal operation, with approximately one-, two- and four-second jittered delays and a ten-second elapsed retry-start budget. That budget does not abort an already-running provider call or guarantee a ten-second request deadline. Persistent failures still fail closed. Generation mismatch, rollback, invalid receipts and an existing quarantine remain denials. HTTP execution retains the existing bounded `waitUntil` protection; this is not durable execution after a Worker crash.

Telemetry emits only fixed R2 read/write retry, database capacity/connection retry and exhausted-budget codes. No provider error message, identifier, URL, credential or SQL text is emitted. The service-lock message explicitly describes a service problem instead of suggesting repeated password attempts will finish a check.

## Remaining architectural work

1. **Remove the shared journal bottleneck.** Each protected operation contends on one R2 control object. Cloudflare documents [one concurrent write per second to a key and 429 responses above it](https://developers.cloudflare.com/r2/platform/limits/). This is a confirmed design constraint, not proof of the October 27 initiating failure. Evaluate a serialized durable coordinator with batched independent checkpoints, bounded admission and recoverable operation states. Preserve independent restore evidence; a database-only outbox can roll back with the database.
2. **Make completion durably recoverable.** Reproduce crashes before/after SQL commit, checkpoint publication, receipt write and pending-list removal. Persist sufficient independent proof to resume known completed work after process loss. Preserve quarantine for genuinely ambiguous commits/restores. Global quarantine should be reserved for unresolved integrity evidence, not recoverable bookkeeping. Cover coordinator restore, regional failure, replay, expiry and revocation before adoption.
3. **Resolve connection exhaustion.** Issue #40 recorded SQLSTATE 53300. Account for all auth/social/jobs pools, deployment overlap and operator headroom against the origin limit. Hyperdrive [pool limits are soft](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/); nominal totals alone are insufficient. Measure under representative concurrency and correct pooling or capacity without terminating member sessions or caching authorization. Transient retries do not solve sustained exhaustion.
4. **Verify recovery and monitoring operationally.** Rehearse the original-primary path and ambiguous-write reconciliation with synthetic data; measure detection/recovery time and verify external alerts. Continue six-user interaction and capacity checks. Datadog remains an implementation option under its deferred issue; the SLO cannot depend on an unconfigured service.

## Acceptance

- Failure injection covers temporary/permanent I/O failure, lost successful write replies, conflicting CAS writes, process loss and actual database rollback. Unknown outcomes never become implicit success.
- Staging passes concurrent synthetic interaction/load and crash-recovery checks. Production passes controlled synthetic acceptance and a sustained watch with exact release provenance and no unrelated feature rollout.
- Monitoring retains real history, reports gaps, checks authenticated behavior and alerts outside the hosting failure domain. Operator and backup response are verified.
- The incident cause and connection issue have evidence-backed resolutions or bounded residual risks. A full 30-day window meets the measured objective; checkboxes cannot substitute for evidence.

Related: [journal recovery #1](https://github.com/porchday/porchday/issues/1), [connection exhaustion #40](https://github.com/porchday/porchday/issues/40), [alerts #8](https://github.com/porchday/porchday/issues/8), [six-user checks #19](https://github.com/porchday/porchday/issues/19), [capacity #9](https://github.com/porchday/porchday/issues/9). Follow [restore safety](restore-safety.md) for recovery.
