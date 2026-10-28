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
5. Every 15 seconds, and when the page is hidden, the browser uploads new spans
   to `POST /api/v1/traces` in batches of at most 200 spans and 56 KB.

Ordinary requests never write trace storage. Only the upload writes.

## Storage and D1 load

Traces live in a dedicated D1 database (binding `TRACES`), separate from
Postgres, so tracing never uses application database connections. Schema:
`apps/api/d1/traces/0001_create_traces.sql`.

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

Members: **Settings → My data → Performance tracing → View**, then **Copy for
builder chat** to paste a plain-text waterfall.

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
the Settings panel says storage is not set up. To enable it in an environment:

```sh
cd apps/api
npx wrangler d1 create porchday-staging-traces
```

1. Record the returned UUID as `traces_d1_database_id` for that environment in
   `infra/resources.json`.
2. Run `python3 scripts/configure-worker.py staging`. The renderer never
   inherits the local placeholder database.
3. Run `npx wrangler d1 migrations apply porchday-staging-traces --remote -c wrangler.staging.jsonc`.
4. Deploy as usual.

Repeat for production. The daily `17 3 * * *` cron applies retention.
