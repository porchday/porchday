# November 3 outage: delayed R2 control read crossed the quarantine horizon

## Corrected finding

A production logout completed its auth work, then waited approximately two
minutes for an R2 read of `control.json` in its completion checkpoint. Cloudflare
recorded that exact object's GetObject as HTTP 500 / internalError at
13:04:39 UTC. Before the read returned, another request found the unfinished
intent older than 120 seconds and quarantined the shared journal. The original
request retried the read, observed quarantine, and failed completion without
publishing its receipt. Subsequent protected requests were denied until guarded
operator recovery.

This establishes the application outage mechanism and the failing provider
operation. Cloudflare's internal reason for returning that 500 is not exposed
by these records. No claim of a regional outage, database failure, Worker crash,
or exact provider timeout setting follows from the evidence.

## Evidence and chronology

Times are UTC; subtract eight hours for Pacific standard time.

| Time | Evidence |
| --- | --- |
| 13:02:35.980 | Independent synthetic journey started; login and authorized reads passed. |
| 13:02:37.705 | Unresolved intent's persisted start time. |
| 13:02:38 | Logout phase telemetry observed handler work and an 18 ms COMMIT measurement. Phase samples are not request identifiers. |
| Around 13:02:46 | The synthetic client exhausted its ten-second journey budget during logout. The server continued processing. |
| 13:03:00–13:04:20 | Other logout requests completed successfully while the older intent remained within its grace period. |
| 13:04:38 | Another logout failed during registration with `journal_begin_failed` and `restore_quarantined`; its auth work never began. |
| 13:04:39 | Cloudflare R2 analytics: recovery-journal bucket, `control.json`, GetObject, internalError, HTTP 500, one observed/estimated request. Application emitted `journal_r2_read_retry`. |
| 13:04:40 | Original long logout completed with HTTP 503 after 123,140 ms. Its request-local timing summary recorded 123,055 ms total, 504 ms auth work, 121,475 ms checkpoint, 121,629 ms cumulative R2 reads, and no receipt or retirement phase. A separate phase observation recorded 121,463 ms for the checkpoint R2 read including retry. |

The request-local summary has sample interval 1. Unlike unrelated phase maxima,
its dimensions belong to one invocation. They overlap, so do not add the R2
read duration to its enclosing checkpoint duration. The original summary is
emitted in the auth handler's `finally`, hence it appears two minutes after
request start. Source inspection shows checkpoint is entered after auth work
returns following an acknowledged COMMIT; the checkpoint first reads SQL status
and then `control.json`. The long checkpoint never reached receipt publication.

The initial investigation queried logout timing only through 13:03:00. That
window missed the failed invocation's summary at 13:04:40. The earlier statement
that retained telemetry could not locate the interruption was premature. The
extended query and independent R2 object-level error establish the missing link.

## Why one transient error became a persistent outage

`resilientJournalIO` awaits each R2 operation without a deadline. Its nominal
ten-second retry budget starts when the first error is caught, not when the
operation starts. An initial read can therefore occupy 120 seconds before the
budget even begins. The existing elapsed-budget test modeled elapsed time only
inside failed operations and did not exercise another request crossing the
stale-intent horizon while a read was pending.

`completePrivacyIntent` writes the receipt only after `checkpointJournal`
returns. `assertJournalReadable` quarantines an unreceipted intent after 120
seconds. Once quarantined, the delayed checkpoint refuses completion. This
preserves privacy safety, but a provider read stall can therefore latch the
entire service closed even after the provider recovers.

The client timeout did not terminate this invocation: it emitted its final
summary and 503 about two minutes later. The delayed phase was an R2 read, not
SQL/advisory lock acquisition. Both observations narrow this incident without
claiming that other interruption modes are impossible.

## Reproduction

`apps/api/test/journal-io.test.ts` now holds completion's first `control.json`
read open, advances the clock, runs an independent journal guard, then rejects
the delayed read and permits the retry. At 9 seconds the intent completes and
retires. At 120,001 ms the independent guard quarantines; the original completion
retries but fails with `RESTORE_QUARANTINED`, leaving the intent and no receipt.

All 14 I/O tests passed against both the current fix branch and an isolated
archive of the exact deployed source, `3d0521225b71bd0c8d6f510ede6556d6815bd3f5`.
This is deterministic fault injection of the observed sequence. It does not
reproduce Cloudflare's internal failure or prove how their backend produced 500.
No fault was injected into production.

## Prevention implications

- A real wall-clock bound must include the initial storage read. Read-only
  fallback/retry can be designed without replaying member work. A timed-out
  write must retain its unknown outcome; a bare Promise.race is not cancellation.
- Durable atomic SQL commit proof and canonical journal reconciliation are
  needed so a completed auth transaction can be distinguished from unknown work.
  The pushed implementation is not yet enabled in production and requires its
  restore/rollback admission checks. The dispatcher alone does not fix this gap.
- A single independently denied session need not become a global unfinished
  intent when the separately validated denial writer/cleanup protocol is active.
  This incident took the global-intent path; do not assume source presence means
  a feature flag was active.
- Incident dispatch and recovery stability are separate process repairs. Alerts
  were delivered, but no consumer started a responder. Two healthy probes inside
  the intent grace period falsely announced recovery. The installed monitor now
  dispatches a task and requires 140 seconds of uninterrupted health.
- Retain bounded operation-local phase summaries through completion, query the
  full possible completion interval, and preserve finite provider error codes.
  Do not log credentials, session identifiers, request bodies or arbitrary error
  messages to improve diagnostics.

Private raw evidence is retained under
`artifacts/private/incident-cause-20261103/`: summaries.json, phases.json,
r2-metrics.json, r2-failure-detail.json, and deployed-source-reproduction.log.
Cloudflare describes the analytics dimensions in its
[R2 metrics documentation](https://developers.cloudflare.com/r2/platform/metrics-analytics/).
A provider escalation needs the exact bucket, object and 13:02:38–13:04:40 UTC
interval to determine the remaining internal service cause.
