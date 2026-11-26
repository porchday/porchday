# Reliability review through November 26, 2026, 00:01 UTC

Reviewed the full48h1m37s since the previous cutoff (November23 23:59:23 UTC). This interval contains failures, not an all-clear. Current readiness passes; recurring storage/network causes remain open in #55/#8.

## Interval evidence

8,644 Mac journeys included25 failed journeys,63 actual failed checks and20 skipped dependencies, versus37 failed journeys in the previous review. No observation gap exceeded45 seconds. Seven HTTP503 checks comprised three logout failures and four protected-readiness failures. Ten revocation checks timed out; four returned200 after an unsuccessful logout, not after acknowledged successful logout. Fourteen ambiguous synthetic-session records remain privately retained for safe reconciliation; none were replayed or cleared by this review.

There were no new #52/#53 comments during the interval. Historical replay produced one outage transition under the old detector and zero under the installed actionable detector. No confirmed detection is missing a review request: failures were isolated or below confirmation duration, and no new incident record, pending review or overdue fallback was found. Both Cloudflare receiver heartbeats are fresh, ready and empty; the daemon connection and live protected readiness were verified. Successful GitHub backup runs remain hours apart, so backup scheduling is still a coverage limitation despite continuous Mac coverage.

## Investigation progress and reproduction

Fetched retained exact-ID edge/API traces for all seven observed503 journeys. Two logout failures reached denial publication and returned `SESSION_DENIAL_UNCONFIRMED` after R2 writes failed or could not be reconciled; a third failed initial authorization after three short rejected R2 reads. These remain unknown mutation outcomes where applicable, not permission to replay logout or alter denial records.

Three readiness failures contain repeated short R2 read errors. The fourth completed its journal/database guard successfully but retained an unfinished R2 read when the request returned503 at2,090ms, consistent with the separate readiness storage deadline. Generic `OPERATION_FAILED` prevents distinguishing a provider error class; no database-guard timeout was established by these selected traces. Transport-only failures include TLS establishment stalls affecting both the application and independent status hostname and must not all be attributed to R2.

Added a deterministic regression reproducing the previously identified retry-cap limitation: fresh reads fail for a400ms simulated storage outage, while the current three-attempt policy ends at360ms despite a two-second ceiling. A new read after recovery succeeds. This is a documented limitation and reproducible fault, not a claim of production remediation. The test preserves denial on unreadable state and does not cache authority or replay mutations. All108 targeted retry, session-denial, monitor, alert and dispatch tests passed.

The next concrete step is bounded provider error classification followed by testing a retry-policy candidate against short bursts, persistent failures and the unchanged authorization deadline. Increasing retries before distinguishing permanent/throttling errors could amplify failure, so this review made no speculative runtime or threshold change.

## Deployment, telemetry and limitations

Provider inventory matches the canonical deployment. Production monitor remains `e190cf1f-bf7e-4f84-a000-f89cf44dc7d0`; staging remains `49db6313-6b87-4b24-aa1b-027683fa931b`. No production deployment, configuration change, privacy mutation or alert suppression was performed. Existing raw failure/SLO history is intact.

Cloudflare rolling aggregate estimates show86 journal read retries, three logout503s and four readiness503s. Reported logout p99 is1,177ms, login530ms; these exclude client/network time. Counters also retain cleanup/journal completion failures for follow-up rather than treating the final healthy probe as resolution. Metrics were queried several minutes after the fixed cutoff; sampled records, trace retention/truncation and unmatched transport-only failures limit causal completeness. All seven selected failed-journey trace groups were available.

Private evidence, replay, exact traces, live readiness/receiver audit, canonical inventory and regression output are under `artifacts/private/health-review-20261125`. No new owner action or urgent incident was established. Open causes and the retry-cap reproduction remain tracked in #55; independent backup/network coverage remains in #8.
