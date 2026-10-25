# Feed performance checkpoint

Measured on 2026-10-25 with the reproducible local fixture in `scripts/benchmark-feed.ts`. Migration `034_feed_candidates.sql` adds a recipient membership index; `/feed` now filters candidates to the member and their current connections before the existing row-level policy decides whether each post is readable. No permissions or privacy policies changed.

## Dataset and method

- PostgreSQL 17.11 in the local Docker development container, on an Apple M4 Pro host with 24 GiB host memory; the container had a 7.75 GiB memory limit. This differs substantially from the proposed hosted database tier.
- 10,000 members and posts, one trusted-device-shaped fixture per member. The active cohort contains 1,000 members, each connected to 300 others in a ring, with a mix of friend/family edges: 150,000 undirected connections total.
- Each active member has one connections post with 100 KiB of high-entropy ciphertext-shaped bytes. The remaining 9,000 posts are small `only_me` posts. There are 310,000 recipient rows, including each author. Timestamps interleave the active and inactive cohorts.
- Fixture bodies are deliberately **invalid OpenPGP**: they approximate stored/returned bytes for the SQL path and do not measure encryption, decryption, or all possible recipient/device metadata sizes. The separate HTTP correctness tests use real signed, encrypted envelopes.
- Queries authenticate as a fresh restricted login inheriting only `porchday_social`, with no superuser or RLS bypass. A direct auth-table read must fail. Each query starts a new transaction and sets `app.member_id` locally, as the application does.
- Five warmup requests precede each batch of 30 measured requests, at concurrency 1, 5, and 10. SQL uses a pool of up to ten connections. Results are warm-cache observations, not a sustained load test or a statistical capacity estimate. The fixture occupied approximately 217 MB after seeding.

## Results

The SQL measurements include `BEGIN`, transaction-local actor setup, the actual feed SQL, row decoding, and `COMMIT`. They exclude the optional JSON stringify measurement, which is preserved in the raw results.

| Variant | Concurrent queries | p50 ms | p95 ms | Errors |
| --- | ---: | ---: | ---: | ---: |
| Original query and indexes | 1 | 107.11 | 112.96 | 0/30 |
| Original query and indexes | 5 | 135.28 | 159.18 | 0/30 |
| Original query and indexes | 10 | 134.82 | 181.38 | 0/30 |
| Recipient membership index | 1 | 52.47 | 56.33 | 0/30 |
| Recipient membership index | 5 | 60.72 | 81.07 | 0/30 |
| Recipient membership index | 10 | 81.34 | 114.29 | 0/30 |
| Index and current-author candidate filter | 1 | 14.44 | 19.08 | 0/30 |
| Index and current-author candidate filter | 5 | 24.37 | 35.35 | 0/30 |
| Index and current-author candidate filter | 10 | 53.05 | 67.61 | 0/30 |

The actual optimized Hono `/feed` handler was also called in-process against the same restricted database. This adds the real per-request connection lifecycle, 30-item pagination, response serialization, response consumption, and JSON parsing. It deliberately injects a synthetic authenticated member in a fixture-only router; it does **not** exercise authentication, the independent journal guard, Hyperdrive, workerd, HTTP/TLS transport, compression, client cryptography, or rendering.

| Concurrent handler calls | p50 ms | p95 ms | Errors |
| --- | ---: | ---: | ---: |
| 1 | 30.11 | 32.33 | 0/30 |
| 5 | 57.53 | 82.89 | 0/30 |
| 10 | 90.27 | 144.84 | 0/30 |

All 360 measured operations succeeded. The SQL fetch includes the extra pagination row and returns approximately 3.20 MB before JSON pagination; the actual 30-item handler response is approximately 3.09 MB uncompressed. This is a significant bandwidth and client processing cost even with fast SQL. Mobile-network timing and real encrypted 300-friend, multi-device envelopes still need measurement; local handler latency does not establish the product's feed latency target.

## Why the change helps

The recipient index matches `can_post`'s `(post_id, member_id)` historical-recipient check. The existing primary key is `(post_id, device_id)`, which required checking many devices to find a member.

The author candidate filter is an ordinary restricted-role subquery over the current member's connections, plus their own ID. It permits no new access and adds no security-definer entry point. The final `app.can_post` policy still checks current membership, family eligibility, blocks, deadlines, and the original historical recipient set. The global `(created_at, id)` ordering and cursor remain unchanged; there is no per-author truncation that could hide later valid pages.

In the captured plan, the original timeline scan examined 1,047 posts to return 31, rejecting 1,016 through the privacy function. The optimized plan still visits the timeline index, but filters unrelated author IDs before evaluating the expensive privacy function. This cuts repeated permission checks; it does not prove that the same plan scales to millions of posts or a member whose connections have no recent posts. Full `EXPLAIN (ANALYZE, BUFFERS)` plans and request observations are in `feed-benchmark-results.json`.

The HTTP suite additionally verifies tied timestamps across two pages, own private posts, family-only visibility, separate group posts, deadline enforcement, future-only access after adding a connection, mutes, blocks, and mutually accepted family demotion using real encrypted objects and the runtime RLS role. All ten social HTTP tests pass after the change.

## Reproduce and next measurements

Run `npx tsx scripts/benchmark-feed.ts --run` with the local `porchday-postgres` container on port 54329. The optional `LOCAL_BENCHMARK_ADMIN_URL` must point to the loopback `/postgres` maintenance database on that port. The script creates a unique disposable database and login, applies migrations there, reproduces the pre-034 index state there, seeds synthetic fixtures, measures all variants, writes the result artifact, and drops its database and login in `finally`. It does not read secrets, select an existing application/test database, alter runtime-role credentials, or contact a provider.

Before expanding the pilot, measure authenticated requests through the deployed Worker and Hyperdrive on the chosen PlanetScale tier, including journal checks, realistic encrypted envelopes, client decryption/rendering, cold starts, constrained networks, and a longer mixed read/write workload. Include older/inactive-friend feeds, multiple posts per member, several devices per member, empty feeds, second/later pages, expiring content, and concurrent privacy changes. Review response byte/page limits if mobile measurements show the current 30-post page is too large. No hosted throughput, 10-million-user capacity, or pricing conclusion follows from this local result.

## Hyperdrive driver compatibility correction

On October 25, 2026, all eleven Postgres.js clients constructed from runtime Hyperdrive bindings were changed from `prepare:false` to explicit `prepare:true`. Cloudflare's current driver guidance warns that disabling prepared statements adds parameter-discovery protocol exchanges that Hyperdrive's transaction pooling does not reliably support. The installed Postgres.js 3.4.9 is newer than Cloudflare's documented minimum. [Cloudflare Postgres.js guidance](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)

This enables prepared SQL statements, not query-result caching. Hyperdrive query caching remains disabled. `fetch_types:false`, pool bounds, connection lifetimes, transaction-local member identity, fresh privacy/session checks and RLS remain unchanged. Direct operator, migration and fixture clients are unchanged because they do not use runtime Hyperdrive bindings. Placement, database size and Better Auth joins are separate experiments and are not part of this correction.

Local verification passed all 119 API checks across 24 test files and the API TypeScript check. The real PostgreSQL 17.11 suites used disposable databases, including restricted-role social/encrypted-content access, integration grants, account/session/MFA security, recovery and privacy journals, expiration/deletion, backups/restore, operational health and both push outboxes. Six account-journal cases were run separately because their existing safety guard requires the dedicated test database name. No tests asserting only the literal driver setting were added. These checks do not establish hosted Hyperdrive compatibility or a latency improvement; both need the subsequent staging checks.

The existing hosted timing sample is directional: auth/session and transaction setup dominated the tiny synthetic feed, with adaptive sampling limiting precise attribution. No speedup is assumed from this correction until hosted measurement. Account C has since been deleted; subsequent baselines must identify the two surviving synthetic accounts and cannot be presented as the identical earlier fixture.

### Hosted evidence before the correction

The opt-in staging sample on `a4f17af` used 100 authenticated feed reads at concurrency five while all three synthetic identities still existed. All returned HTTP 200; client p50 was 672 ms, p95 1,106 ms and maximum 1,358 ms. The temporary phase flag was then removed. These are observations on a tiny fixture, not a capacity estimate.

| Fixed phase | Weighted mean ms | Weighted p95 ms |
| --- | ---: | ---: |
| auth_session | 227 | 277 |
| auth_status | 44 | 57 |
| journal_check | 90 | 114 |
| journal_close | 0 | 0 |
| social_connect_begin | 127 | 398 |
| social_actor | 86 | 98 |
| social_query | 57 | 82 |
| social_commit | 43 | 50 |
| social_close | 0 | 0 |

Analytics Engine adaptively sampled these points. `auth_session` had eight observed points representing 36 weighted observations; other phases had 11–19 observed points representing 46–146 weighted observations. There are no per-request correlations. Different phase samples cannot be added to reconstruct request latency, and their p95 values must not be summed. Zero cleanup duration is at the runtime timer's resolution, not proof of zero work. The evidence motivates investigating database round trips and placement while preserving fresh checks; it does not isolate database CPU, network, pool acquisition and library overhead within each phase.

A separate public-page baseline before any placement change used ten sequential requests per endpoint, all HTTP 200. Staging `/` measured p50 67 / p95 490 ms, staging `/health` 58 / 79 ms, and production `/` 83 / 610 ms. Staging was the ordinary flag-disabled `a4f17af` deployment; production remained `c72e15f`. These small samples include cold/warm variance. They provide public-shell context for a possible later placement experiment because `run_worker_first:true` and the `ASSETS` binding currently route assets through the Worker. They are not evidence of a placement improvement or regression.

### Two-survivor baseline after the correction

Staging `e1679d7`, deployment `dd855f34-2dea-45ae-91f1-0cb112cd1d15`, was independently verified through `/health` before and after this sample on October 25 at approximately 18:00 UTC. Phase diagnostics and placement were disabled; Better Auth joins remained unchanged. A separate bounded driver compatibility check completed its temporary fixture deletion and signed out before measurement began. Account C had been deleted, leaving two synthetic identities. The latency runner authenticated only A, made no content/relationship/key changes, and signed out in `finally`.

The 100 authenticated reads at concurrency five returned **99 HTTP 200 responses and one HTTP 503**. Client p50 was **647 ms**, p95 **833 ms**, maximum **1,281 ms**, including the failed response. The runner exited unsuccessfully because all 100 reads must succeed. It consumed the response bodies without recording error classifications, so the cause of the single 503 is unconfirmed. No automatic rerun replaced this result. The response must be investigated before interpreting a later placement sample; public health remaining HTTP 200 does not establish that all database/privacy checks were healthy. The p95 remains above the 500 ms objective. This changed fixture and small single-client sample cannot establish a strict improvement over the earlier three-identity measurements or pilot capacity.

The operator's subsequent aggregate query for the last 15 minutes returned exactly one `journal_unavailable` event and no `request_failed` event. This points toward the independent privacy guard, but does not identify its underlying failure or establish a per-request correlation. Placement is on hold during that investigation. Future latency runs now report only aggregate counts of fixed allowlisted server error codes, including `PRIVACY_CHECKPOINT_REQUIRED`, or `UNCLASSIFIED` for unknown, malformed or oversized error bodies. No response content, messages, headers or request identifiers are logged; successful content is never parsed for diagnostics.

The separate public sample used ten sequential requests per endpoint, all HTTP 200:

| Endpoint | p50 ms | p95 / maximum ms |
| --- | ---: | ---: |
| Staging `/` | 40 | 380 |
| Staging `/health` | 15 | 18 |
| Production `/` | 40 | 363 |

The production sample is context only; production was not changed by the staging driver experiment. A possible next controlled experiment is explicit staging placement near the existing Oregon database, using `placement: {region: "aws:us-west-2"}`. The installed Wrangler schema accepts that setting, and PlanetScale maps `us-west` to Oregon. It remains a proposal, not a deployed or verified optimization. Keep all existing fresh checks and measure public assets as well as the feed because assets currently traverse the placed Worker. [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/), [asset-routing behavior](https://developers.cloudflare.com/workers/static-assets/binding/), [PlanetScale region mapping](https://planetscale.com/docs/plans/regions).

### Baseline after the journal recheck correction

At approximately 18:10 UTC on October 25, staging `a19cb86`, deployment `f384074f-8b17-41ec-b1a6-df33f5927ecb`, was independently verified through `/health` and sampled once. This release includes the prepared-statement correction and the reviewed bounded privacy-checkpoint recheck/fixed failure taxonomy. Placement and phase diagnostics remain disabled; Better Auth joins, database tier and freshness checks remain unchanged. The earlier failed result above is retained; this is a new release checkpoint, not a silent retry.

The fixture still had two surviving synthetic identities, but A now had **two registered devices** following hosted browser verification at 18:02:56. Historical envelopes were unchanged. Archive-test writes were held until this feed sample and A's logout completed. This device change and ordinary temporal/network variance prevent treating older samples as an identical controlled baseline.

The runner made **100 authenticated feed reads at concurrency five**, all **HTTP 200**, with **zero classified errors**: client **p50 716 ms**, **p95 1,060 ms**, **maximum 1,515 ms**. It signed A out and made no content, relationship or key changes. This small sample passed the request-success criterion but still exceeds the 500 ms feed objective and does not establish pilot capacity. No additional retry was run.

The read sample waited until the earlier media-deletion queue completed normally at 18:07:50.759; the operator observed zero pending items at 18:08:49. The associated monitoring-policy correction was not deployed for this measurement. Thus a pending delayed cleanup operation was not intentionally included in the feed baseline.

Public checks immediately afterward used ten sequential requests per endpoint, all HTTP 200:

| Endpoint | p50 ms | p95 / maximum ms |
| --- | ---: | ---: |
| Staging `/` | 37 | 595 |
| Staging `/health` | 18 | 34 |
| Production `/` | 30 | 490 |

The recommended next experiment is a staging-only explicit Oregon placement change, independently verified and compared with a newly labelled sample of the current fixture. Keep the same driver/code, fresh journal/session/status checks, RLS, disabled query caching and database tier. Measure both the feed and public assets, preserve all failures, and revert or investigate if errors recur. This remains a recommendation; no placement setting or claimed improvement is part of this checkpoint.

### Prepared staging-only Oregon experiment

The staging configuration now contains `placement: {region: "aws:us-west-2"}` for an isolated experiment; this preparation does **not** deploy it. The operator will apply this configuration change to the current `a19cb86` API code after the browser archive run and its cleanup finish. Production, the configuration generator, application code, database tier, authentication, privacy checks and asset routing are unchanged by this preparation. Do not run `scripts/configure-worker.py` over the experimental configuration without reviewing the resulting diff: the generator intentionally does not yet retain this trial setting.

The hypothesis is that reducing Worker-to-database round trips will help the measured authentication and transaction phases. The database's PlanetScale `us-west` region maps to AWS Oregon (`us-west-2`). Cloudflare's explicit region hint selects a Cloudflare location with low latency to that region; it does not run the Worker inside AWS or guarantee one physical data center. The exact setting was rechecked against current primary documentation and validated against the installed Wrangler 4.152.0 placement schema. [PlanetScale regions](https://planetscale.com/docs/plans/regions), [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/).

This is also a public-asset experiment. `run_worker_first:true` sends requests through Worker code, and the fallback calls `ASSETS.fetch`. Assets fetched through that binding are served from the Worker's location, so explicit placement can affect homepage, script, stylesheet and image latency as well as the API. This does not relocate the uploaded asset storage itself. Keep routing unchanged for this comparison. [Cloudflare asset routing](https://developers.cloudflare.com/workers/static-assets/binding/), [placement behavior](https://developers.cloudflare.com/workers/configuration/placement/#placement-behavior).

After deployment is independently verified, measure one bounded 100-read feed sample at concurrency five, plus public `/`, `/health` and representative built asset requests. Keep all HTTP failures and fixed error-code counts; a recurrence of privacy-guard errors requires investigation before retrying. Record the release, deployment, time, account/device count and any archive-test changes to surviving content. Those changes prevent treating the earlier sample as an identical fixture. Do not overlap measurement with archive imports/deletions or other synthetic writes.

The available client is in California. These samples can show observed feed and public-response behavior from that location, including a large regression, but cannot establish global performance, eastern-US or overseas asset latency, browser rendering, constrained mobile networks, sustained capacity or the actual Worker location from timings alone. Ten sequential public requests are especially sensitive to cold/warm and network variation. A faster local result is evidence for further validation, not sufficient reason to copy the setting into production or the generator. If request errors recur or public latency worsens materially, preserve the result and remove the staging placement setting before the next controlled comparison.

### Oregon placement observation

At approximately 18:23 UTC on October 25, the operator deployed `b0c9488` to staging as `e25e95b0-a48b-4b27-b282-ffc8cf740ce2`. `/health` independently confirmed that exact version before and after measurement. The API code remained `a19cb86`; the experiment changed only staging placement. Migration 041 had also been applied additively without its new runtime policy, so the environment was not byte-for-byte identical to the earlier baseline. Provider settings reported targeted placement with an encoded target; this is configuration evidence, not proof of the location serving each request.

The browser archive check finished before measurement: its new private copies were deleted, original profile/content and A's two-device set were preserved, and the browser signed out. The sample still used the two surviving synthetic identities and A's original runner device. Intervening archive outbox work, elapsed time and network variation remain comparison limitations. No browser, integration or content writes overlapped the measured reads.

The single bounded feed sample made **100 requests at concurrency five**, all **HTTP 200**, with **zero classified errors**. Client **p50 was 404 ms**, **p95 687 ms**, and **maximum 1,069 ms**. A signed out afterward. These observed values are lower than the preceding 716 / 1,060 ms sample, but p95 still exceeds the 500 ms objective. This is directional evidence for placement, not causal proof, sustained capacity or an achieved SLO.

Public requests followed sequentially, ten per endpoint, all HTTP 200; p95 is the maximum of each small sample. Asset bytes were fully consumed, just as feed bodies were; no browser rendering or client decryption is included.

| Endpoint | p50 ms | p95 / maximum ms | Response bytes |
| --- | ---: | ---: | ---: |
| Staging `/` | 91 | 271 | 888 |
| Staging `/health` | 60 | 84 | 109 |
| Staging built entry JavaScript | 148 | 731 | 233,086 |
| Staging built stylesheet | 115 | 433 | 85,959 |
| Staging `icon-192.png` | 83 | 507 | 4,584 |
| Production `/` (unchanged control context) | 38 | 339 | 888 |

The homepage and health medians rose from 37 / 18 ms before placement to 91 / 60 ms afterward; the homepage tail happened to fall. Cold/warm variance and ten observations prevent a firm regression estimate. The representative asset samples have no equivalent pre-placement baseline, so no asset speedup is claimed. This California-only evidence supports further staging diagnosis while leaving production and the generator unchanged. Any decision to retain placement must account for public delivery farther from Oregon, and the remaining feed latency needs investigation without weakening fresh security checks.

### Prepared session/user join experiment

The next change enables only Better Auth's `advanced.database.joins:true`. The installed Better Auth and PostgreSQL adapter version is **1.7.12**, whose native join implementation supports Porchday's custom `auth_session` and `auth_user` table names. The session lookup becomes one SQL join instead of a session query followed by a user query. This option is documented by the [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql). It does not enable query-result or cookie caching.

A controlled local probe used all **42 migrations** and a newly created login inheriting only `porchday_auth`, with synthetic signed session cookies. Exactly one auth instance was constructed per comparison. Both the direct `pg.Pool` configuration and the explicit `PostgresDialect` transaction configuration returned identical session/user values. For a current, non-refreshing session, the observed queries were:

| Configuration | Schema validation | Session/user reads | Current member status | Total |
| --- | ---: | ---: | ---: | ---: |
| Joins disabled | 2 | 2 | 1 | 5 |
| Joins enabled | 2 | 1 | 1 | 4 |

The two schema-validation reads check the search path and table columns. They remain enabled, as does the separate current member-status query. The initial exploratory probe constructed two auth instances and consequently counted duplicate schema validation; that discarded count is not production evidence. No local query-count result establishes a hosted latency improvement.

The committed regression exercises the actual factory and restricted role, verifies the joined query and cross-user session selection, and checks that a reused auth instance still observes changed email verification, expired sessions and immediate session deletion. The real member/appeal middleware still denies held accounts, restricts suspended accounts to the existing permitted data/appeal routes, rejects unverified members, and preserves the original session creation time for recent-auth checks. The actual account route rejects an old session with `RECENT_AUTH_REQUIRED`. Schema validation, signed cookies, disabled cookie cache, per-request account checks, privacy journal checks, RLS, disabled Hyperdrive query caching, session refresh policy and database tier are unchanged.

On October 25, all **17 tests across six files** passed in a separate temporary PostgreSQL container: the new join regression plus existing authentication, MFA/account security, account boundaries, recovery and account-journal integration suites. The API TypeScript check also passed. The temporary container and exploratory databases/logins were removed; no hosted account or provider configuration was changed by this verification.

The staging plan is to deploy the reviewed change after the ongoing browser checks and fixture hold finish, preserving the existing Oregon placement and using the current fixture with its account/device/content state recorded. Then run one bounded 100-read, concurrency-five sample with exact release/deployment verification, response-body consumption, fixed error-code counts and logout, without overlapping content or account mutations. Compare against a clearly labelled baseline and preserve failures; do not infer an achieved 500 ms objective or a specific speedup from removing one SQL round trip. No joined-session deployment or hosted performance result is claimed in this checkpoint.
