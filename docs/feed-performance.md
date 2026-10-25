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
