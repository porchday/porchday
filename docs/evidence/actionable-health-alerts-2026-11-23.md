# Actionable health notifications — November 23, 2026

The owner reported continued daily notification churn despite recovered checks and previously inconclusive reviews. Recovery is not resolution.

## Confirmed notification defects

- [07:13 UTC service/path event](https://github.com/porchday/porchday/issues/52#issuecomment-7094110451) was followed by a separate [responder-dispatch failure](https://github.com/porchday/porchday/issues/52#issuecomment-7094117847), mislabeled as another availability outage. These are separate event IDs, not duplicate delivery.
- [07:54 UTC freshness-only event](https://github.com/porchday/porchday/issues/52#issuecomment-7094831657) was followed by the same [responder escalation](https://github.com/porchday/porchday/issues/52#issuecomment-7094839162). A stale heartbeat did not establish application downtime.
- GitHub backup treated a previous successful run older than twelve minutes as a failed execution. Delayed/dropped scheduled starts could therefore generate an outage/recovery pair on each healthy backup execution.

## Remediation

Candidate d5c5b23 keeps raw probe frequency, request budgets, privacy enforcement and append-only history unchanged. Transport-only notifications require a contiguous 120-second failure interval; monitor-only notifications require 600 seconds and identify monitoring trouble explicitly. HTTP failures retain two-observation confirmation. Accepted old-cookie access after an acknowledged logout alerts immediately. A 140-second continuous healthy interval confirms recovery. Dispatcher errors are coalesced with an already-notified incident; standalone errors are explicitly monitoring faults with hourly deduplication. GitHub successful-run gaps are structured coverage evidence, not application outages; actual unsuccessful executions remain monitoring alerts. The separately installed November 21 session reconciliation is preserved.

Replay of 15,837 observations since November 20 retains 35 failed journeys: twelve transition messages under the old reducer, zero under the new paging policy. This is a bounded retrospective result, not a future alert guarantee or a monthly SLO claim. Focused fault tests explicitly exercise sustained failures and security exceptions.

87 focused tests and strict monitor TypeScript checks passed. Maintained `verifyReleaseCi` and `verifyProductionNativeParity` gates verified exact source `d5c5b23cede6e8f017ecefe03cd7e76e5b049540`:

- [Full CI](https://github.com/porchday/porchday/actions/runs/45218539079) and [secret scan](https://github.com/porchday/porchday/actions/runs/45218539427).
- [iOS simulator, cryptographic interoperability and launch evidence](https://github.com/porchday/porchday/actions/runs/45218539278) and [macOS build/contract tests](https://github.com/porchday/porchday/actions/runs/45218539030).
- [PR #245](https://github.com/porchday/porchday/pull/245) merged as `731de126a02402b3d345020e4cd8aa5cdfcbccb7`; its tree matches the verified candidate.

The continuous Mac monitor was replaced at **17:01:26 UTC**, with the shared deployment lock held, the old daemon stopped, and configuration, durable state, historical observations and session evidence preserved. Installed bundle SHA-256: `7512f7adf3b67c84392ed639ac29eba55191b0a1e799779e1cccde6f48ef3b11`. The canonical application deployment record is unchanged.

Eight consecutive full journeys passed through **17:03:48 UTC**, spanning 141 seconds. All nine checks passed each time, including logout and rejected old-cookie access (401). One daemon was running, the installed bundle/configuration hashes matched, and no notifications were pending. The restart observation interval was 5.262 seconds, with no missing scheduled observation interval.

The [non-drill GitHub backup run](https://github.com/porchday/porchday/actions/runs/45223045775) passed both journeys and reported no open incident. It explicitly recorded a **25,760-second prior-run gap** while correctly recognizing the previous execution as successful; it generated **zero new #53 comments**. This verifies the fixed healthy-job behavior while preserving evidence that GitHub scheduling is not reliable continuous coverage. The independent 20-second Mac monitor remains active.

Private installation, gate, history-replay and post-release receipts are retained under `artifacts/private/actionable-alerts-20261123`. No credentials or member data are in this report. Physical-device acceptance and signed native distribution are not claimed.

The 48-hour review automation now requires interval-wide findings, retained unresolved causes, and concrete investigative/remediation progress. A healthy final probe cannot justify an all-clear report.

## Still unresolved

The shared Mac network-path stalls and occasional Cloudflare R2/database dependency failures remain investigations in #8/#55. Existing cross-process evidence does not identify an exact router/ISP cause. This change fixes paging actionability; it does not repair those underlying failures, change the Cloudflare Worker email policy, or establish 99.99% availability. No Worker/API or native binary distribution is part of this monitor release.
