# Availability objective: 99.99%

Porchday's availability objective is **at least 99.99% per calendar month**, with a rolling 30-day operational trend. This is a target to demonstrate, not an achieved result or a contractual SLA. A working homepage is insufficient: people must be able to sign in, read their authorized feed, and perform core social actions. The October 27 production quarantine counts as an outage, even though `/health` returned 200.

Thirty days contain 43,200 minutes. The downtime budget is **4 minutes 19.2 seconds**. Planned maintenance, deploy-related failures and privacy-quarantine outages count. Missing monitoring is unknown, never silently healthy. Recovery does not reset the error-budget history. Calendar-month budgets are 241.92 seconds for 28 days, 250.56 seconds for 29 days, 259.2 seconds for 30 days, and 267.84 seconds for 31 days. Use UTC month boundaries consistently and retain completed-month reports. Minute-resolution protected readiness is supporting evidence; it cannot by itself establish precise end-to-end availability at this target.

## Measurement and response

- Record one-minute protected readiness checks, including failed checks before the alert threshold and gaps in observations. Retain at least 30 days of timestamped aggregate outcomes. Publish coverage and collection start alongside any percentage; do not invent older observations.
- Add authenticated synthetic journeys from two independent US locations outside Cloudflare: login, feed, create/read/delete synthetic posts and comments, and logout/revocation. Use isolated identities and encrypted synthetic payloads, never real-member accounts. Separate mail-delivery checks from synthetic reads. A 200 shell or anonymous session response does not certify these journeys.
- Track request availability per core route: successful eligible requests divided by all eligible requests. Count 5xx, timeouts, unintended 429 and incorrect outcomes; exclude expected authentication/validation rejections. Report sampled aggregate metrics as estimates. Static asset traffic must not hide a broken login or write route.
- Target detection within 30 seconds and automated recovery of proven-safe transient failures within 60 seconds. Escalate unresolved outages immediately to the primary responder and after two minutes to the backup. These are objectives to verify, not current capabilities: the existing Cloudflare monitor requires three failed minute checks and cannot meet this detection objective. Human-only ten-minute recovery already exceeds the whole 30-day budget. Verify an alert channel outside Cloudflare. Disaster recovery has separate RPO/RTO requirements.
- When the 30-day error budget is exhausted, stop feature/topology promotions. Permit reviewed reliability, security and recovery changes through staging. Release serialization, exact-source CI, provider-state reconciliation and rollback checks remain required. Never relax authorization, expiry, encryption or revocation to improve the number.
- Review incidents, causes and budget consumption weekly. Claim 99.99% only after a complete measured window meets the target, with core-journey and regional coverage disclosed. A short healthy smoke test cannot establish this.

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
- The incident cause and connection issue have evidence-backed resolutions or bounded residual risks. A full calendar month meets the measured objective, with the rolling 30-day trend also reported; checkboxes cannot substitute for evidence.

Related: [journal recovery #1](https://github.com/porchday/porchday/issues/1), [connection exhaustion #40](https://github.com/porchday/porchday/issues/40), [alerts #8](https://github.com/porchday/porchday/issues/8), [six-user checks #19](https://github.com/porchday/porchday/issues/19), [capacity #9](https://github.com/porchday/porchday/issues/9). Follow [restore safety](restore-safety.md) for recovery.

## October 28 corrective design and rollout gates

See the [incident and recovery evidence](incident-2026-10-28.md).

The recurrence began with database connection/capacity retries at 09:46 UTC and account-access quarantine at 09:49 UTC, without an intervening deployment. SQLSTATE 53300 is confirmed by the deployed fixed-code classifier. Four operations lacked completion receipts. The exact source of excess connections and the SQL outcomes are not established by those metrics. Public `/health` continued returning 200; this incident demonstrates why shell-only checks cannot govern releases or recovery.

Apply these workstreams in order, retaining their distinct acceptance evidence:

1. Recover the original primary using the guarded runbook, preserving capabilities and all historical failures. Never automatically remove quarantine based only on a matching sequence or a successful connection.
2. Bound origin connection use. Inspect actual allocation across all three runtime roles, background jobs, deployment overlap and reserved operator capacity. Evaluate the [included PlanetScale transaction pooler](https://planetscale.com/docs/postgres/connecting/pgbouncer) on staging with the actual drivers, prepared statements and transaction-local identity settings. A port change is not a verified solution: measure its per-role server pools and overload behavior before promotion. Keep administrative and recovery connections direct. [Dedicated highly available PgBouncers](https://planetscale.com/docs/postgres/connection-resilience) or increased database capacity require a costed proposal and owner approval before purchase.
3. Make privacy completion durable with independently persisted operation identity and commit evidence, bounded admission, and a recoverable coordinator. Reconcile proven completions after process loss; keep genuinely ambiguous outcomes blocked. Test crashes at every SQL/R2 boundary, database rollback, concurrent operations and missing evidence. A SQL-only completion row cannot prove that a restored database has not lost an acknowledged operation. Preserve the independent journal and compatible release path.
4. Add external, bounded probes of login, authorized reads, encrypted synthetic writes/deletes and logout, plus public monitor freshness. Use independent execution and alert delivery; no production credentials in CI artifacts or logs. Never use real members as probes. Record per-journey latency, failures and unknown intervals; keep destructive synthetic actions confined to the probe's own records. A scheduled GitHub job alone is not a sub-minute paging service.
5. Gate releases on exact-source tests, staging failure drills, compatible schema, external journey checks and a known-good rollback version. Verify post-deploy behavior and automatically stop promotion on failure. Roll back executable regressions only when schema and runtime settings are compatible; rollback cannot resolve an ambiguous database commit or provider outage.

The request path depends on DNS/TLS and Cloudflare routing, Worker/assets, the independent R2 journal, Hyperdrive, and the PlanetScale primary. Authentication additionally depends on credential state and, for email flows, email delivery. Media depends on R2; background completion depends on queues and cron. The minute monitor and its alert email share Cloudflare. An additional [external Mac monitor with GitHub owner notifications](external-monitor.md) now checks authenticated reads and readiness every 20 seconds while the host is running. A GitHub-hosted manual run and bot relay now pass live checks, and GitHub inbox delivery is verified for the signed-in owner; one automatic scheduled run is verified, but later scheduled runs were absent during the October 29 incident; reliable schedule coverage and the second responder’s receipt remain unverified. The watch has also exposed logout/journey deadline failures tracked in [#55](https://github.com/porchday/porchday/issues/55). Separate monitoring reduces the detection blind spot but does not add application failover. Database replicas, dedicated poolers and a second hosting provider must be evaluated against tested failover behavior, consistency, operational burden and cost; do not introduce an untested active-active private-data path.

Implementation is incomplete. The existing minute monitor, retries and manual recovery do not establish this target. Preserve #1, #40, #8 and #42 until their acceptance evidence exists.

## October 29 recurrence

The [October 29 incident record](incident-2026-10-29.md) documents another unresolved journal completion followed by production quarantine. Guarded recovery restored access without an application deployment or capability reset. Independent monitoring detected the recurrence and published owner alerts, but manual recovery still exceeded the entire monthly downtime budget. The initiating completion failure, durable recovery design and operator cleanup/transport gaps remain open under #1, #55 and #42.

## Confirmed auth rollback correction

The [October 29 rollout record](auth-rollback-rollout-2026-10-29.md) records the
production deployment of a narrowly scoped fix: an acknowledged PostgreSQL
rollback before any COMMIT attempt now supplies completion evidence to the
privacy journal. Uncertain commits, lost rollback replies and receipt failures
remain unresolved. This closes a reproduced defect; it does not prove the cause
of the earlier incident or solve durable recovery for every interrupted request.

## Production session-denial reader verification

[Nine hosted production checks](evidence/session-denial-production-2026-10-29.json)
verified that an immutable denial rejects the exact synthetic session while its
SQL row remains present. A separate session remained usable, and fresh login
worked with the denied cookie. Test sessions were removed and the immutable
denial retained. An uncertain publication response was reconciled by exact
read-only record comparison; the write was not replayed. No application version,
writer/cleanup flag, schema or routing changed during this verification.

The independent logout writer remains disabled. Hosted push enforcement,
writer/cleanup failure and concurrency cases, device behavior and cost acceptance
remain required before enabling it. This reader evidence does not resolve all
interrupted privacy operations or establish the availability SLO.


## Denial-cleanup readiness signals (staging deployed)

The v2 denial-cleanup implementation adds independent protected-readiness checks
when `SESSION_DENIAL_CLEANUP_V1=true`. Normal cleanup freshness cannot substitute
for these checks. Staging version `966329b9` emits these codes after a verified real initial sweep
and scheduled-progress observation. Production has not received this monitoring
release and keeps the writer/cleanup flags off. Hosted failure-alert and recovery
verification remain pending.

- `session_denial_cleanup_missing` / `session_denial_cleanup_unavailable`: inspect
  configured storage, permissions and the versioned progress record privately.
  Missing, corrupt, future-dated or timed-out evidence must not be marked healthy.
- `session_denial_cleanup_stale`: no confirmed page in three minutes. Inspect the
  minute schedule, queue delivery/retries, independent storage and SQL lock/errors.
- `session_denial_pass_stale` / `session_denial_pass_slow`: full-pass completion or
  traversal exceeded the five-minute operational limit. Inspect history size,
  cursor advancement and repeated page failures even if page health is fresh.
- `session_denial_cleanup_invalid`: preserve private evidence and investigate record
  integrity. The alert clears only after a complete clean pass. Never delete or
  expire denial authority as a way to clear an alert.

After repair, verify actual scheduled progress, a fresh clean full pass, protected
readiness and external monitoring. Never manufacture timestamps or reset members'
sessions/keys. Reader enforcement remains active independently of SQL cleanup.
See the [progress design and rollout requirements](../design/durable-session-revocation.md#independent-denial-cleanup-health-staging-deployed).

A staging progress-read failure/recovery drill on October 29 verified readiness
failure while ordinary cleanup remained healthy, recovery after exact conditional
restoration, and subsequent scheduled full-pass progress. The shared GitHub relay
published both events as drills; bot comments were verified, but owner inbox
receipt remains pending in #52. Notification dispatch followed restoration, so
this does not measure automatic alert latency. See the [scoped evidence](evidence/session-denial-health-failure-staging-2026-10-29.json).
