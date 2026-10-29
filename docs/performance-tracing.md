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
2. **Send now**, then confirm the visit appears and **View** shows the
   request, its server spans (`journal_check`, `auth_session`,
   `social_query`, `r2_media_get`) and a non-`headers_only` photo request.
3. **Copy for builder chat** produces the waterfall text.
4. Turn tracing off and confirm requests no longer carry `traceparent`.
5. **Delete my traces** and confirm the list is empty.
6. `npx tsx scripts/query-metrics.ts staging trace-store` shows
   `trace_write_ok` points and no `trace_write_failed`; `connections` shows the
   `/api/v1/traces` route's connection use.
7. The next day, confirm a `trace_cleanup_ok` point from the `17 3 * * *` cron.

### Privacy-write phase diagnostics

Opted-in HTTP traces include fixed `privacy_` phase names for guard,
registration, work, checkpoint, receipt, retirement, close and nested R2/database
I/O. This allows an edit's durability overhead to be separated from handler work.
The existing aggregate exporter remains limited to explicitly enabled logout
requests. Ordinary untraced edits do not allocate a journal timing observer.
Anonymous requests receive no internal Server-Timing details.

Phases may overlap: nested R2/database durations must not be added to their parent
phases. The existing request trace span cap also applies; omitted phases are
missing evidence, not zero duration. Phase tracing does not bypass journal
registration, durable completion, original error handling or disconnect retention.

#### October 29 staging write diagnostic

Exact-runtime candidate `75c92e1` passed CI run 40793155412 and ran briefly as
staging API `fb844261-1ad6-46e8-b229-8e45c965361b`. One synthetic self-only post,
one edit and one reaction succeeded, each with independent signature/decryption
read-back. Measurements started at 00:23:08.738, 00:23:11.135 and 00:23:15.933 UTC.

| Operation | Action to acknowledged response | Including verification read-back | Mutation server duration |
| --- | ---: | ---: | ---: |
| Post | 1191.6 ms | 2396.2 ms | 531 ms |
| Edit | 4039.8 ms | 4796.4 ms | 3006 ms |
| Reaction | 1036.3 ms | 1534.9 ms | 445 ms |

The edit's non-overlapping journal phases were guard 66 ms, registration 704 ms,
wrapped work 257 ms, checkpoint 1054 ms, receipt 257 ms, retirement 420 ms and
close 0 ms (rounded). Journal phases excluding wrapped work totaled 2501 ms;
248 ms preceded the guard. This identifies the awaited journal as the dominant
cost in this observation, not a reason to bypass its durability requirements.
New posts and reaction additions do not traverse this privacy-mutation wrapper;
absence of their journal spans is expected, not a zero-cost journal measurement.

The private collector's phase regex omitted names containing digits, so nested
`privacy_r2_read`/`privacy_r2_write` timings were not retained. Do not infer absent
R2 work or attribute parent-phase time to specific storage calls from this run.
The tested `scripts/privacy-write-timing.ts` parser now retains every emitted
journal phase, including repeated R2 spans, without summing nested durations.
Another bounded diagnostic using it is still needed for that missing detail.
No raw response headers or private content were retained in the numeric evidence.

This is one observation per operation on a desktop runner, with tracing enabled,
unverified region/network and a small self-only audience. All acknowledged times
exceeded one second; none establishes p99, regional or phone performance. There
were no measured failures, timeouts or retries. A Node module-resolution failure
occurred before any test intent/network traffic; the collector then ran once via
`tsx`. No uncertain mutation was repeated.

The owned post was deleted and returned 404; the session was signed out and its
saved cookie returned 401. Original staging API
`f504e9c9-04ab-414f-9a75-daeed914144d` was restored. Provider verification preserved
all 24 web assets, runtime settings and production state. The canonical provider
record was reconciled and the deployment lock released. Evidence is archived in
the primary checkout's `artifacts/private/p99-write-tracing-20261029/`.

#### Corrected R2 diagnostic, October 29

A second bounded run reused the verified inactive candidate above, without a new
upload. Every mutation's release header matched the candidate. The corrected
allowlisted parser retained R2 names; the test required edit work, R2 read and R2
write evidence before counting the edit as successful.

| Operation start (UTC) | Action to acknowledgement | Including read-back | Mutation server |
| --- | ---: | ---: | ---: |
| Post, 00:25:37.093 | 1761.9 ms | 2326.0 ms | 881 ms |
| Edit, 00:25:39.420 | 4063.6 ms | 4664.0 ms | 2898 ms |
| Reaction, 00:25:44.085 | 1074.6 ms | 1638.7 ms | 493 ms |

Edit phases were guard 73 ms, registration 634 ms, work 209 ms, checkpoint 998 ms,
receipt 323 ms, retirement 427 ms and close 0 rounded. Before guard: 234 ms.
Six R2 writes took 281/276/331/240/323/315 ms (1766 ms total); five reads took
73/77/148/212/112 ms (622 ms total). These sequential R2 spans occupy about 82%
of the 2898 ms server interval. They are nested inside the parent phases and must
not be added to them. Individual I/O spans include any adapter retries; this
collector does not establish whether each was one provider attempt.

The evidence points toward reducing required storage round trips or their latency,
while preserving durable intent registration, immutable checkpoints/receipts,
conditional updates, restore detection and concurrent-operation correctness.
It does not support bypassing durability, acknowledging unconfirmed writes, or
claiming that application/database work has no further optimization potential.

One sample per operation again, with all cryptographic read-backs passing and no
measured failure/timeout or collector replay. Same desktop/unverified-region and
network limits as the first run. All acknowledgements exceeded one second; no
percentile claim. Owned-post deletion/404 and signout/old-session 401 passed.
Rollback to the original version, provider/canonical reconciliation, all 24 assets
and production preservation were verified, and the lock was released. Evidence,
including the corrected parser, is archived in primary
`artifacts/private/p99-write-tracing-r2-20261029/`.

#### Storage-backend investigation after the R2 measurements

The six writes preserve separate immutable intent, batch and receipt records plus
conditional control updates. Existing recovery and receipt-reconciliation tests
exercise those independent records. Removing receipts or retiring before durable
completion would change the recovery contract and is not an accepted optimization.
The read-only provider query reports the staging journal bucket as WNAM, Standard,
default jurisdiction. That does not identify an exact data center, but gives no
obvious configured cross-continent placement mistake to correct.

Investigate an isolated SQLite-backed Durable Object journal-store benchmark
before changing any active journal. Cloudflare documents transactional, strongly
consistent storage and 30-day point-in-time recovery in its
[storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
These properties make it a candidate, not evidence of lower hosted latency or
recovery equivalence. [Location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/)
are not a regional performance guarantee. Keep the existing R2 journal authoritative.

The first prototype must implement only the existing get/conditional-put contract
against synthetic keys, with no application binding or member route. Test immutable
conflicts, compare-and-swap races, lost successful replies, restart persistence and
failure propagation. Preserve exact bytes, fresh version tokens and atomic
precondition checks; no deletion, public endpoint, unbounded retries or automatic
fallback to an older backend. Await storage durability before a successful reply.
Benchmark the same sequential operation shape and record failures and cold/warm
conditions. Local/emulated speed is not hosted evidence. Stop this candidate if it
does not materially reduce the measured round-trip cost.

Promotion would separately require a restore/export tool, immutable-chain and
receipt proofs, prohibition of restoring the journal behind acknowledged state,
capacity/retention limits, old/new reader compatibility, and a rollback procedure
that cannot expose a stale R2 journal after new writes. An asynchronous R2 mirror
alone cannot authorize rollback. Any migration needs a verified frozen checkpoint
and explicit authority handoff; dual writers or silent backend fallback are
unacceptable. Preserve the existing journal as authoritative until every migration
and recovery gate is demonstrated. No new backend has been provisioned or enabled.
