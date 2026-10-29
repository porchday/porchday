# Cleanup operating-cost scenarios

October 29 provider analytics establish a useful usage estimate, not a complete
operating budget. Production admission on cost remains open under #9 and #42.
No subscription, capacity tier, paid commitment or runtime setting changed.

## Measured windows

Read-only GraphQL queries covered the staging recovery-journal bucket and all
four staging work queues. They requested operation/status aggregates, never
object names or member data. The initial query had a missing closing brace and
returned a syntax error; the corrected query succeeded. Both responses remain
in private evidence. These are adaptive analytics, not settled invoice totals.

| Window (UTC) | Duration | R2 GET 200 | R2 GET 404 | R2 PUT 200 | Queue billable operations |
| --- | --- | --- | --- | --- | --- |
| Combined workload, 22:42:55.557–22:46:06.765 | 191.208 s | 1,037 | 11,258 | 185 | 93 |
| Idle staging, 22:52:00–22:55:00 | 180 s | 36 | 9 | 18 | 36 |

The workload window includes normal journal/monitor activity and operator reads.
It excludes the 400 immutable denial writes prepared before SQL seeding. The
idle window follows fixture teardown and isolated-topology restoration, before
the contention rehearsal. Normal cron and monitoring continued. Neither window
isolates every cost attributable to this feature.

Queue reads/deletes were 30/30 during the workload, versus 33 writes. The
difference can cross the window boundary; it is not evidence of lost delivery.
All returned delete outcomes were successful. Application telemetry's separately
sampled 11,403 authority reads must not be added to the provider GET count.

Sources: [R2 analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
and [queue metrics](https://developers.cloudflare.com/queues/observability/metrics/).
The latter exposes billable operations directly; the former supplies request
counts by operation/status rather than an invoice.

## Reproducible scenarios

Using Standard R2 rates of $4.50/million writes and $0.36/million reads, with
monthly allowances of 1 million and 10 million respectively, and paid Queues at
$0.40/million operations above 1 million, gives the following 30-day scenarios.
R2 billable usage rounds upward in million-operation units; queue arithmetic
uses the provider's proportional formula. Prices checked October 29:
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).

| Repeat the observed rate continuously | Gross rate subtotal before allowances/rounding | Isolated subtotal with all monthly allowances available |
| --- | --- | --- |
| Combined workload processing window | $71.79/month | $65.62/month |
| Idle staging window | $1.61/month | $0.00/month |

These subtotals cover only the recorded R2 and queue operations. They are neither
an upper bound nor a forecast that users will repeat this burst continuously.
The isolated allowance column cannot be added across staging, production or
other workloads: allowances are shared. The gross column is rate arithmetic,
not the invoice with exhausted allowances, because invoice rounding also applies.

All GETs, including 404 responses, are conservatively modeled as Class B.
The cited pricing page exempts authentication/authorization failures and explains
that some other failures are billable; it does not establish a waiver for these
missing-object reads. Confirm their treatment against account billing before
reducing this estimate. The account's contract and remaining allowances have
not been verified by these queries.

Reproduce from the sanitized provider counts and dated assumptions:

```sh
python3 scripts/test_denial_cost_estimate.py
python3 scripts/denial-cost-estimate.py docs/evidence/denial-cost-input-2026-10-29.json
```

The [input](denial-cost-input-2026-10-29.json) and
[calculated result](denial-cost-estimate-2026-10-29.json) retain full precision.
Four tests cover rounding at allowance boundaries, proportional queue billing,
negative/nonfinite values, observation scaling and invalid durations/counts.

## Remaining budget evidence

Worker CPU is not wall-clock duration. The authority wait timings cannot price
CPU. Worker requests/CPU, Analytics Engine, retained immutable objects, backup
storage, database storage/egress, ordinary application traffic and the Mac mini's
power/network are outside these subtotals. The existing approximately $60/month
platform base in the [cost ledger](../cost-ledger.md) is separate, with its original
invoice limitations; do not present a combined total as verified spending.

The existing database tiers and pooling settings were retained in the load
trial. Connection samples establish neither a database cost increment nor
headroom for the complete feeds/posts/images pilot mix. Obtain a representative
longer usage window and reconcile account allowances/invoices before closing
cost acceptance. Do not weaken denial reads or the 180/300-second freshness
requirements to lower an estimate.
