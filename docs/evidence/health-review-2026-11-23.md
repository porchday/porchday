# Reliability review through November 23, 2026, 23:59 UTC

Reviewed the full interval since the previous November 22 00:02:50 UTC cutoff, plus the preceding minutes needed for a full 48-hour window. This is not an all-clear: recurring transport/storage failures and independent coverage gaps remain open in #8/#55.

## Interval and notification results

- 8,533 Mac journeys; 37 failed journeys, 84 actually failed checks and 56 skipped dependencies. This increased from 18 failed journeys in the previous scheduled review; these are synthetic observations, not a traffic-wide availability estimate.
- One 2,164.8-second observation gap occurred November 22 21:33–22:09 UTC. Host reboot evidence places a reboot at 21:47 UTC inside the gap. This explains an interruption but does not establish the cause or every minute of missing coverage. No post-installation observation gap exceeded 45 seconds.
- After the November 23 18:10:35 UTC agent-first installation: 1,046 journeys, one failed journey, two actual HTTP503 checks, no skipped checks, no confirmed alert transition and no new comments in #52/#53 through cutoff.
- Across the whole window, #52 retained six failure and four recovery notifications plus investigation comments; #53 retained six failure/recovery pairs. All were before the new installation. Successful backup workflows remain separated by hours; the latest scheduled backup at 21:43 UTC succeeded. Scheduling remains a coverage limitation.

Historical replay advanced this review beyond a current-status check: the old detector produced five outage transitions from the same raw 48-hour sequence; the current actionable detector produced two, both before installation. The isolated post-installation503 did not cross confirmation criteria. No histories were deleted and no model dispositions were fabricated during replay. 107 regression tests passed, covering storage retry/denial behavior, sustained faults, alert decisions, structured review, dispatch and monitor channels.

## New trace correlation

The sole post-installation failed journey, at 21:29:57 UTC, has retained trace `88165d2de5e64b4a8067a2886e22e6f6`. Both feed/profile503s reached the API and failed during session authorization: each exhausted three fresh R2 reads, with failed calls lasting roughly62–76ms and backoff. The session-authorization phase ended after422–427ms, before its two-second ceiling. Journal database reads succeeded; this episode is not evidence of a database guard timeout or solely a Mac network failure. Readiness recovered using its bounded storage retry path. Logout succeeded and subsequent denial verification passed. The next full journey was healthy.

This localizes the immediate cause to exhausted R2 read attempts, but generic `OPERATION_FAILED` spans do not identify the underlying provider error. The established three-attempt cap can end before the deadline; simply increasing a timeout would not change that cap. Further work should first retain bounded, privacy-safe provider error classifications and reproduce short-failure bursts before choosing a retry-policy adjustment. Do not cache authorization decisions, bypass denial checks or replay uncertain writes. Historical database guard timeouts remain unresolved rather than disproved by this sample.

Two older revocation checks returned200 after logout had failed at transport; neither was accepted access after an acknowledged successful logout. Existing ambiguous synthetic-session evidence remains preserved, not silently cleared.

## Live infrastructure and investigation audit

Provider inventory matches the canonical deployment: production monitor `e190cf1f-bf7e-4f84-a000-f89cf44dc7d0`, staging monitor `49db6313-6b87-4b24-aa1b-027683fa931b`. No deployment changes were made by this review. The Mac monitor and responder daemon are running; both private Cloudflare inboxes have fresh ready heartbeats, no active aggregate incidents and no backup signal. No pending notification or overdue review exists.

Archived records retain two pre-repair dispatch failures; the already-delivered missing-daemon repair addresses that confirmed failure path, not an inferred root cause for daemon exit. Both later accepted pre-installation incident turn IDs were read back as completed and their investigation findings remain in #52. No confirmed post-installation detection needed a new request/disposition. Quiet-path behavior is supported by actual no-notification observations and regression coverage; this does not claim a new production outage drill occurred.

Cloudflare aggregate estimates show two server errors, six journal read retries and no database-read-failure counter in the rolling48-hour query. Reported route p99s include logout1,177ms and login555ms; these exclude client/network time. Trace ingestion is current, with9,667 retained last-day trace records, nine error records and1,440 records marked as having dropped spans. Trace sampling/truncation limits completeness; transport requests without a retained server trace cannot be assigned an application cause. The aggregate query window is shifted a few minutes after the fixed monitor cutoff. All selected post-installation failed-journey traces were retained.

Owner-only evidence is in `artifacts/private/health-review-20261123`, including fixed-cutoff observations, policy replay, provider inventory, issue history, exact-turn receipts, traces and regression output. Next action remains the targeted storage error-classification/retry investigation in #55 and independent host/network/backup coverage work in #8. No new owner action or urgent incident was established by this review.
