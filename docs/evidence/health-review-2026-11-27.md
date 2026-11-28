# Reliability review and completed-investigation readback fix — November 27, 2026

Reviewed November25 23:58:36 through November27 23:58:36 UTC: a full48-hour window covering the unreviewed interval, with a small overlap before the prior cutoff. Findings remain under #8/#55. Current recovery does not resolve recurring storage/network failures.

## Confirmed notification defect and remediation

The telemetry investigation `b3c82228-d2ce-49e0-979c-9e14b7de2862` began November26 16:01:52 UTC and completed at16:05:31 with valid incident-bound JSON and an evidence-backed `notify` disposition. The daemon returned its turn as `itemsView: notLoaded` with `items: []`. The dispatcher treated the empty array as loaded output, skipped the exact-turn message fetch and recorded `INCIDENT_REVIEW_INVALID`. A fallback alert followed at16:17, despite the completed investigation; recovery notification followed at16:34. This was a result-readback defect, not a failure to launch the responder.

[PR #247](https://github.com/porchday/porchday/pull/247), source `93ea063a57a09c616efd92e9910b34233e579784`, fetches the bounded exact-turn messages when items are unloaded or absent. Incident/turn identity and structured-result validation remain unchanged. A regression using the actual response shape failed before the fix and passed afterward, including progress commentary before the final JSON. Forty targeted tests and the external-monitor typecheck passed. An isolated state copy recovered the actual retained result using the corrected parser, without starting inference or writing production state.

Exact-source full CI46085564187, secret scan46085564193, iOS46085564110 and macOS46085564100 all passed. Native implementation parity was explicitly audited; this changes only independent operator monitoring, not application behavior or signed native distribution.

The Mac bundle was installed at November28 00:13:38 UTC after release-lock and idle/outbox checks, with SHA-256 `d2f114b60660887821ad3828720e77a2127631e3b5c2776bf8581c3b01e19eb8`. The valid archived receipt was restored under an original-record hash check; the original invalid record and notification history remain retained. No duplicate owner notification was queued. Configuration and canonical Cloudflare deployments were unchanged. Existing telemetry/storage investigation findings remain open; restoring a receipt does not change its `notify` decision to a benign result.

## Interval evidence and remaining causes

8,639 Mac journeys included18 failed journeys,50 actual failed checks and20 skipped dependencies, compared with25 failed journeys in the prior review. No gap exceeded45 seconds. Five HTTP503 checks comprised three logout failures, one readiness failure and one anonymous-session failure. Three revocation checks returned200 after failed logout, not after acknowledged success. Unknown synthetic-session outcomes remain preserved; no mutation was replayed.

Retained exact-ID edge/API traces correlate all five503 journeys. Two logout failures reached the four-second denial-publication deadline with an unfinished R2 PUT; another reached its roughly two-second initial-authorization read deadline. Readiness exhausted journal read attempts; the anonymous-session failure reached the five-second journal-read deadline. Generic provider errors and unfinished spans prevent attributing the provider's internal cause. These traces do not establish the historical database-guard cause. Transport failures continue to include TLS connection stalls and are not all application failures.

#52 retained the fallback/recovery pair above; #53 had no new comments. One confirmed aggregate telemetry incident had a completed investigation but an invalid retained readback; that receipt is now repaired. A later closed `watching` record was an unconfirmed transient, not an undispatched confirmed incident. Both receiver heartbeats were fresh and ready, with no current aggregate incidents or pending notifications. Successful GitHub backup jobs remain separated by hours, retaining the independent coverage limitation.

The telemetry investigator's retained evidence says fresh queries passed but historical per-poll query/parse/heartbeat failure reasons were not retained. That root cause is still unknown. A concrete next diagnostic improvement is bounded private telemetry failure classification before the next incident; it is not justified to infer a cause from later successful queries.

Cloudflare rolling aggregates retained71 journal-read retries and journal/cleanup failures; logout p99 was1,221ms and login444ms, excluding client/network time. Trace ingestion was current; last-day records included1,440 with dropped spans. Metrics windows are offset from the fixed cutoff, aggregate sampling and trace truncation limit completeness, and no trace cannot prove a request never reached the service. Provider inventory matched canonical; no Cloudflare Worker, API, frontend or privacy-control deployment occurred in this review.

Private evidence is in `artifacts/private/health-review-20261127`: interval observations, exact-turn metadata/output, before/after regression, isolated real-turn acceptance, release gates, installation receipt, preserved original archive, provider inventory, traces and issue history. The notification parser is remediated; recurring provider/transport/telemetry causes remain open.

## Post-install verification

At November 28 00:16:34 UTC, nine complete journeys from 00:13:38 through 00:16:18 passed all nine checks, including login/logout/revocation, over 159.9 seconds. Both receiver heartbeats were fresh and ready, with no current incidents or pending notifications. The running bundle matched the installed hash and the restored archived investigation retained its valid `notify` decision. This short window verifies installation continuity; it does not establish long-term reliability or resolve intermittent storage faults.
