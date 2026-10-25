# Operational metrics without request logs

`apps/api/src/telemetry.ts` writes an explicitly constructed aggregate event to the optional `METRICS` Analytics Engine binding. Callers pass the current environment directly; there is no shared mutable environment or member context. The request middleware records method, HTTP status, elapsed milliseconds and a fixed route category. Job, email and error call sites use fixed codes and bounded counts. Hosted console output is unnecessary and disabled by this exporter; deployment configs also disable persisted Workers Logs, invocation logs, traces and Logpush.

No point includes a raw URL, query string, member/post/device/session/request ID, IP address, user agent, cookie, authorization header, SQL statement, email address, post text, encrypted content, key material, exception message, request body or response body. Unknown dimensions and out-of-range numbers are dropped before calling the binding. There is no browser/mobile telemetry SDK, third-party script, session replay or automatic request enrichment in this path. Cloudflare still operates the hosting infrastructure; this describes our emitted Analytics Engine data, not every category of provider account/security metadata.

## Configuration and delivery

`scripts/configure-worker.py staging|production` adds one binding with a distinct fixed dataset name:

| Environment | Binding | Dataset |
| --- | --- | --- |
| Staging | METRICS | porchday_staging_operations_v1 |
| Production | METRICS | porchday_production_operations_v1 |

The renderer still requires verified database bindings before generating a deployable configuration. No metrics deployment is performed by these source changes. Local development omits the dataset and can use the same sanitized console fields. Cloudflare creates a dataset on its first bound write, and `writeDataPoint` returns immediately while the runtime handles the write; it needs neither `await` nor `waitUntil`. [Cloudflare setup and write API](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)

Missing bindings, synchronous failures and rejected injected adapters do not fail or delay the application. Delivery is best effort, with no application retry queue and no acknowledgement of durable ingestion. A missing point is not evidence that an application action failed. Native background delivery failures cannot be counted reliably by the same writer; query freshness and compare synthetic requests with resulting aggregates to detect a broken pipeline. Keep the independent availability monitor and database-backed backlog/expiry health checks active when analytics is unavailable.

## Version 1 point schema

Positions have stable meanings. Change the schema marker/dataset version before reinterpreting a column.

| Column | Meaning |
| --- | --- |
| index1 | Fixed `event:route` class used for sampling, never a person or random identifier |
| blob1 | `porchday_metrics_v1` |
| blob2 | development, staging or production |
| blob3 | request, job, email or error |
| blob4 | `/api/v1/feed`, a fixed allowlisted auth action, `/api/auth/*`, `/api/*`, `/assets/*`, `/health`, or `none` |
| blob5 | Allowlisted HTTP method or `none` |
| blob6 | Allowlisted operational code or `none` |
| blob7 | HTTP status class such as `5xx`, or `none` |
| double1 | HTTP status 100–599, otherwise 0 |
| double2 | Rounded duration 0–3,600,000 ms, otherwise −1 |
| double3 | Integer operation quantity 0–1,000,000, otherwise 0 |

Every event is one observation; use the sampling weight to count events. `double3` measures a batch quantity where supplied: for example deleted objects or delivered/retried outbox entries. Email provider acceptance and outbox completion are different stages, so do not sum their event counts as unique email deliveries. Queue retry/duplicate delivery can repeat operational events; these metrics are not an accounting or security audit ledger. Request duration covers server handling through response creation, not network transfer, client decryption, image loading or rendering.

## Read-only queries and response checks

Use an account-scoped **Account Analytics / Read** token for operators or monitoring consumers. The existing setup credential was verified by the primary agent to permit the SQL API; a dedicated read-only token is preferable for ongoing consumers. Keep credentials in the private environment and never place them in command arguments, URLs, SQL text or this repository. The query helper sends fixed aggregate SQL to Cloudflare's Analytics Engine SQL API and prints only selected result columns; it suppresses provider diagnostics. [SQL API authentication](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)

```sh
python3 scripts/with-secrets.py npx tsx scripts/query-metrics.ts staging summary
python3 scripts/with-secrets.py npx tsx scripts/query-metrics.ts production counters
python3 scripts/with-secrets.py npx tsx scripts/query-metrics.ts production freshness
python3 scripts/with-secrets.py npx tsx scripts/query-metrics.ts production usage
```

`CLOUDFLARE_ANALYTICS_READ_TOKEN` takes precedence over the existing setup token. Summary/counters/freshness use a 15-minute window; usage uses 30 days. The helper enforces fixed environment/query choices, a 30-second timeout, no redirects and a 1 MiB response limit. It makes no database or configuration changes.

The feed/auth summary uses this query shape, with the environment-specific dataset substituted by the helper:

```sql
SELECT blob4 AS route,
       sum(_sample_interval) AS requests,
       sum(if(double1 >= 500, _sample_interval, 0)) AS server_errors,
       sum(double2 * _sample_interval) / sum(_sample_interval) AS mean_ms,
       quantileExactWeighted(0.95)(double2, _sample_interval) AS p95_ms
FROM porchday_production_operations_v1
WHERE timestamp > NOW() - INTERVAL '15' MINUTE
  AND blob1 = 'porchday_metrics_v1' AND blob3 = 'request' AND double2 >= 0
GROUP BY route
ORDER BY requests DESC
FORMAT JSON
```

For counters, group by `blob3, blob6`, use `sum(_sample_interval)` for observed event totals and `sum(double3 * _sample_interval)` for batch quantities. Cloudflare can sample both writes and reads. Always weight counts, means and percentiles by `_sample_interval`; unweighted `count()` or `avg()` can mislead. `quantileExactWeighted` is the supported weighted percentile function, but sampling still makes the result an estimate of original traffic. Our bounded sampling keys deliberately contain no member identity. Rare errors, small samples and short windows need synthetic/backlog checks in addition to aggregate estimates. [Sampling behavior](https://developers.cloudflare.com/analytics/analytics-engine/sampling/), [weighted aggregate functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/)

## Pilot checks, retention and cost

After the backend exists, verify a synthetic request reaches the correct environment dataset and inspect the complete stored row for unexpected fields. Test a token-bearing auth URL and a synthetic failure without real member content. Verify that removing/failing the metrics binding leaves health, authentication and cleanup behavior unchanged. Do not interpret successful local unit tests as proof of hosted ingestion or alert delivery.

Review the last 15 minutes of feed latency and 5xx counts against the provisional pilot target, with an adequate request sample. Investigate rising cleanup/email/auth retry codes alongside the independent monitor's aggregate health snapshot. Verify fresh synthetic requests appear before relying on an empty error chart. Missing data or query failures mean monitoring is unavailable; they do not mean the service is healthy. A configured notification consumer must apply these checks and route meaningful incidents to the named operator before claiming automated latency/telemetry-loss alerts are live.

Cloudflare currently retains Analytics Engine data for **three months**. Its documented limits include 20 blobs, 20 doubles, one index of at most 96 bytes, and 250 points per invocation; our schema uses seven blobs, three doubles and one short index. The current call sites emit a bounded number of points per request or batch. No individual deletion or configurable shorter retention is assumed. Review this provider retention in the privacy notice. [Limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)

As checked on 2026-10-25, Cloudflare says Analytics Engine usage is **not currently billed**, while publishing future Workers Paid allowances of 10 million writes and one million read queries per month, then $0.25 per additional million writes and $1 per additional million queries. Each write call counts before adaptive sampling; sampling is not an ingestion budget control. Check the live billing page again before expansion. [Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)

The pilot emits each reviewed server event and relies on Cloudflare's weighted sampling for stored/query volume. Monitor attempted writes through provider usage and compare trends with the helper's weighted estimate; do not treat the estimate as a billing statement. Review the budget at eight million monthly writes or an unexpected growth trend. Any later application sampling of routine successes must record its own probability and adjust query weights, while preserving useful failure observations. Do not invent per-member labels to avoid sampling. Datadog remains deferred in the current design; adding it later requires the same allowlist and disclosure review.

Verification on 2026-10-25: eleven local tests cover exporter redaction, bounded fields, environment isolation, immediate/no-op delivery, failing sinks, actual Hono success/403/413/503 responses, the transactional-email adapter, distinct rendered datasets, disabled persisted request logs/traces, weighted queries, and bounded/sanitized query responses. API TypeScript checks also pass.

The primary agent also ran `scripts/probe-metrics-cloud.ts` against an isolated Cloudflare dataset through a temporary authenticated Worker using the actual bundled exporter and native binding. Independent SQL reads verified six synthetic points across three attempts: the expected feed/status/duration and error fields, no supplied private marker or query token, and only the expected Analytics Engine fields (including provider timestamp, sample weight and dataset name). Ingestion exceeded the first short polling window; the final probe completed successfully after allowing that delay. Temporary Workers and domains were independently confirmed removed. No member data or application database was used. This verifies synthetic provider ingestion and reads; deployed application traffic, ongoing freshness checks and notification rules still require their own verification.

All four actual query-helper SQL shapes were then executed read-only against that same isolated dataset, changing only the fixed dataset constant in a temporary copy of the helper. Cloudflare accepted the weighted percentile syntax and returned: summary three feed requests, zero server errors, mean/p95 both 12 ms; counters three error events with zero batch quantity; freshness six events with the expected latest timestamp; and 30-day usage six estimated events. Every helper exited successfully, and the temporary source copy was removed. No query implementation change was needed.
