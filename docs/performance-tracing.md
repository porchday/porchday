# Performance tracing

Opt-in, first-party, end-to-end performance traces. A member turns tracing on
for one browser in **Settings → My data → Performance tracing**. Each page load
on that browser then becomes one trace: the page load, every API request and
photo fetch with its network breakdown, the Worker's own steps inside each
request, decryption and photo decoding, milestones such as vault unlock and
first photo, long tasks and uncaught errors.

## Policy

Porchday allows no third-party telemetry, no fingerprinting and no privacy
invasion. First-party diagnostics that a member opts into are allowed. For
tracing that means:

- Off by default, per browser, and only for signed-in members.
- Traces go only to Porchday's own Worker and D1 database. No third-party
  script, SDK, vendor or session replay.
- Traces may include real IDs from URLs (post, photo, group and device IDs),
  span names, timings, byte sizes, HTTP status, Cloudflare edge, release ID,
  coarse browser version (for example `Chrome 141`) and network type (for
  example `4g`).
- Errors record the error class, Porchday error code and Postgres SQLSTATE, and
  a message of at most 200 characters with email addresses and long opaque
  tokens replaced. No stack traces.
- Traces never include post text, comments, photos, profile fields, decrypted
  content, keys, cookies, tokens or request and response bodies.
- Each trace is tagged with the member ID. Members see only their own traces.
  Traces are deleted 14 days after their last upload, when the member presses
  **Delete my traces**, or when they delete their account.

## How a trace is built

1. The browser module `apps/web/src/tracing.ts` creates a random trace ID per
   page load and adds a W3C `traceparent` header to same-origin `/api/*` and
   `/health` requests.
2. `apps/api/src/tracing.ts` keeps request-local spans for traced requests
   using `AsyncLocalStorage`. Existing phase timing (`RequestTiming`,
   `measureFeedPhase`) feeds it, so the journal check, auth session and status,
   social connect, actor, query, commit and close steps, R2 photo reads and
   database connection counts (`db_conn_social`, `db_conn_jobs`,
   `db_pool_auth`) all appear without per-route code.
3. For a signed-in member the Worker returns those spans in `Server-Timing`
   (`pd-span`, `pd-count`, `pd-route`, `pd-edge`, `pd-release`, `pd-total`,
   `pd-error`). Anonymous callers never receive them. These entries also show in
   the browser's DevTools Timing tab.
4. The browser reads them from Resource Timing and nests them under the request
   that produced them. Server clocks and browser clocks are not compared: server
   spans are placed inside the interval in which the browser waited for the
   response.
5. Once a minute, and when the page is hidden, the browser uploads new spans
   to `POST /api/v1/traces` in batches of at most 200 spans and 56 KB.

Ordinary requests never write trace storage. Only the upload writes. Each
request's duration runs from its start to the end of its body download
(`responseEnd`); a request with no matching Resource Timing entry is marked
`headers_only`. If the server has no trace storage, the browser stops
collecting for that page and releases its buffers. Buffers are capped at 2,000
entries each, so a tab that cannot upload does not grow without bound.

## Storage and D1 load

Traces live in a dedicated D1 database (binding `TRACES`), separate from
Postgres. Schema: `apps/api/d1/traces/0001_create_traces.sql`.

Storage uses no Postgres, but **uploads do**. `/api/v1/traces` is an ordinary
member route, so each upload passes the fresh privacy journal check and member
authentication like every other request, which opens jobs and auth
connections. That is why uploads happen once a minute rather than more often.
The always-on connection metrics in
[operational-metrics.md](operational-metrics.md#connection-accounting-issue-40)
report this cost under the route `/api/v1/traces`; measure it against #40
before enabling tracing for more than a few members. Fresh authentication is
not skipped for uploads.

Write pressure is limited on purpose:

- One upload is one D1 `batch` round trip with two statements. All spans are
  inserted by one statement through `json_each`, which also avoids D1's limit
  of 100 bound parameters.
- The Worker returns `202` and writes in `waitUntil`, so the browser never waits
  for D1.
- Each isolate allows at most 4 concurrent trace writes and 10 per second, with
  bursts up to 30. Writes over the limit are dropped and counted, never retried.
- Uploads are idempotent per `(trace_id, seq)`, and a trace stops accepting
  spans after 5,000.

## Monitoring D1

Every D1 call emits a `trace_store` Analytics Engine point: outcome code, wall
time (`double2`), D1's own reported duration (`double4`) and rows read or
written (`double3`). Codes are `trace_write_ok`, `trace_write_failed`,
`trace_write_throttled`, `trace_read_ok`, `trace_read_failed`,
`trace_cleanup_ok` and `trace_cleanup_failed`.

```sh
npx tsx scripts/query-metrics.ts production trace-store
```

Watch for a rising `trace_write_failed` or `trace_write_throttled` count, or a
widening gap between wall time and D1 duration, which means time spent reaching
D1 rather than executing queries.

## Reading traces

Members open the performance inspector at `/app/performance`, linked from
**Settings → My data → Performance tracing**. It shows only the member's own
traces and has:

- a picker for one page load, with tiles for feed loaded, first photo shown,
  API requests, failed requests and median server time;
- a timeline of that page load. Each request is split into time queued in
  the browser, waiting on the server and downloading. Selecting a request shows
  the server's own steps inside it, and dashed lines mark milestones;
- **Where server time goes**: the median and 95th percentile of each server
  step across all retained traces, for successful requests only;
- **Slowest requests by route**: count, failures, and median, 95th percentile
  and maximum times per route, with photo requests grouped by route pattern;
- **Copy for builder chat**, which copies a plain-text waterfall to paste.

The two summaries come from `GET /api/v1/traces/summary`. It runs two bounded
D1 reads of at most 20,000 rows each, and computes the percentiles in the
Worker because SQLite has no percentile function. Like every other trace read,
it reports a `trace_read_ok` or `trace_read_failed` point. The inspector's
code loads only when the page is opened, so it adds nothing to the main
bundle.

Operators and builders, using wrangler's own Cloudflare login:

```sh
npx tsx scripts/query-traces.ts production recent [member-uuid]
npx tsx scripts/query-traces.ts production show <trace-id>
npx tsx scripts/query-traces.ts production slow [hours]
```

`slow` groups spans by name, with photo and post requests grouped by route
pattern, and lists p50, p95 and maximum durations.

## Provisioning

Until a database is bound, the endpoints return `404 TRACING_UNAVAILABLE` and
the Settings panel says storage is not set up. Enable staging first. For
production, substitute `production` for `staging` in every name below
(`porchday-production-traces`, `wrangler.production.jsonc`).

From `apps/api`, create the database:

```sh
cd apps/api
npx wrangler d1 create porchday-staging-traces
```

From the repository root, record the returned UUID as
`traces_d1_database_id` under `environments.staging` in
`infra/resources.json`, then render the configuration. The renderer reads
repository-relative paths and never inherits the local placeholder database:

```sh
cd ../..
python3 scripts/configure-worker.py staging
git diff apps/api/wrangler.staging.jsonc
```

Before continuing, reconcile the rendered file with the currently deployed
topology. The only intended change is a `d1_databases` entry whose
`database_name` is `porchday-staging-traces` and whose `database_id` is the
new UUID. Any other difference (routes, placement, pauses) must be explained
by current infrastructure state before deploying.

From `apps/api`, apply the schema and confirm it:

```sh
cd apps/api
npx wrangler d1 migrations apply porchday-staging-traces --remote -c wrangler.staging.jsonc
npx wrangler d1 execute porchday-staging-traces --remote -c wrangler.staging.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"
```

The second command must list `trace_spans`, `traces`,
`traces_member_started` and `traces_received`. Then deploy as usual.

### After each deployment

The Node, Hono and SQLite tests do not establish hosted browser behavior.
After staging, and again after production, verify with a member account:

1. Turn tracing on, load the feed and open a photo.
2. **Send now**, then confirm the visit appears in the inspector and its
   timeline shows the request, its server spans (`journal_check`,
   `auth_session`, `social_query`, `r2_media_get`) and a photo request split
   into waiting and downloading (not `headers_only`).
3. The inspector's summaries list the feed and photo routes, and **Copy for
   builder chat** produces the waterfall text.
4. Turn tracing off and confirm requests no longer carry `traceparent`.
5. **Delete my traces** and confirm the list is empty.
6. `npx tsx scripts/query-metrics.ts staging trace-store` shows
   `trace_write_ok` points and no `trace_write_failed`; `connections` shows the
   `/api/v1/traces` route's connection use.
7. The next day, confirm a `trace_cleanup_ok` point from the `17 3 * * *` cron.
