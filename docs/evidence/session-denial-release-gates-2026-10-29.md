# Session-denial production admission audit

This source/evidence audit follows the successful isolated cleanup trial. It
does not enable production writers or claim new hosted test results. Tracks #42
and #9; source inspected at `ac291bdb0e04d45a30a62b4072da4e2d7c9e4c52`.

| Gate | Existing evidence | Remaining acceptance |
| --- | --- | --- |
| Cleanup capacity | [Isolated staging trial](denial-isolated-combined-staging-2026-10-29.md): 10,000 live sessions retained, 400 denied sessions drained in 184.093 seconds; healthy journeys and journal recovery | Preserve the tested queue admission and pooling constraints during production preparation. This does not establish the broader pilot workload or costs. |
| Reader enforcement | [Production reader verification](session-denial-production-2026-10-29.json): exact denied session rejected while SQL row retained; separate session and fresh login usable | Hosted web/native push paths and device behavior remain separate. |
| Web/native push suppression | `apps/api/test/push.test.ts` and `native-push.test.ts` exercise real SQL with an injected authority store and send function: denied session skipped, separate session sent, unknown/malformed/missing authority retries without sending | Demonstrate the deployed worker's authority lookup and outbox outcome while the denied SQL session still exists. Separately verify actual delivery and revocation on owned devices. |
| Writer failures and concurrency | `auth-journal.integration.test.ts` covers unconfirmed publication, lost replies, late commits, SQL cleanup failure, real identity-lock contention and both controlled password/logout orderings | Hosted owned-fixture rehearsal with durable operation intent, bounded observation, exact cleanup and journal recovery. Preserve password-change SQL completion before HTTP success. |
| Cleanup failure and overlap | `session-denial-batch.integration.test.ts` covers restricted-role ordering, overlapping ranges, lost setup reply, pre-commit rollback, unknown commit convergence, owner changes and deadline/prefix behavior | Map any hosted failure claims to actual evidence; local fault injection is not a hosted process interruption. Do not repeat the accepted capacity trial merely to cover these distinct cases. |
| Progress and recovery | Partition/candidate/runtime tests cover CAS loss, stale/cross-range tokens, late authority reads, restored rows behind cursors, missing/future progress and lost sends; staging evidence includes mode transitions and shared/isolated return | Controlled return proves compatibility, not an automatic fault-triggered rollback. Preserve that distinction in production admission. |
| Operating cost | Capacity trial includes sampled authority activity, queue completions and database observations | Forecast normal and burst usage from measured operations, including idle scans, retries, monitoring and duplicate work. Sampled maxima are not peak guarantees or billing totals. |
| Daily releases | Existing guarded activation evidence checks allowed/revoked sessions and continuity across version changes | Retain old/new client and backward-compatible schema checks; installed service-worker and physical native-device behavior cannot be inferred from API continuity. |
| Availability objective | External 20-second monitor and release/recovery evidence exist | Actual calendar-month and 30-day observation, core journey coverage, and remaining recovery gates. The prior outage and coverage gaps remain in the accounting. |

## Next hosted check

Prepare a staging-only writer contention rehearsal using newly allocated owned
synthetic identities. Hold only the fixture identity's advisory lock, issue one
logout, and verify the durable denial rejects that session while an unrelated
session remains usable. Release the lock and observe normal cleanup and journal
publication. Record dispatch intent before the request; an unknown reply must
be reconciled through the original operation, never by replaying logout. A
bounded lock lifetime and cleanup path are required before execution. This
exercises the deployed storage, SQL timeout and queue recovery path without
injecting a failure into shared storage or changing global availability.

For push suppression, prevent cleanup from being mistaken for reader enforcement:
the evidence must establish that the SQL session remained present at delivery
preparation. Do not pause global cleanup, weaken endpoint validation, or enroll
another person's device to obtain that evidence. The existing
`scripts/hosted-app-push.ts` checks an opted-in successful browser delivery; its
`sent` outbox assertion does not test denied-session suppression. It is not an
appropriate unchanged runner for the missing gate.

No test was run and no deployment or provider setting changed during this audit.
