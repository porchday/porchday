# Bounded database connections

The October 28 outage included PostgreSQL SQLSTATE 53300. Three Hyperdrive pools connected directly to a server limited to 25 connections. Hyperdrive's configured limit of five per role is [a soft limit](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/), so it cannot reserve recovery headroom by itself.

The corrective path uses the existing [PlanetScale local PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer), on port 6432, between Hyperdrive and PostgreSQL. Auth, social and jobs retain separate credentials and transaction-local authorization. Query caching remains disabled. Operator migrations and guarded recovery keep their direct port-5432 connections.

## Configuration and limits

The staging configuration was applied and verified on October 28:

| Parameter | Value | Purpose |
| --- | --- | --- |
| PgBouncer processes per node | 1 | A per-process cap must not be mistaken for a global cap. |
| Pool mode | transaction | Release the backend at transaction end. |
| Default pool size / maximum per user | 4 / 4 | Bound each role's server allocation. |
| Maximum server connections per database | 12 | Bound the sum across roles. |
| Reserve pool | 0 | Prevent an unbudgeted overflow pool. |
| Client queue timeout | 5 seconds | Refuse prolonged queueing instead of the prior 120-second wait. |
| Server idle timeout | 30 seconds | Return unused backends promptly. |

These are provisional limits, not a throughput certification. Twelve application backends plus observed provider/admin backends leave room under the current 25-connection server ceiling. Include direct clients, superuser-reserved slots, process count, failover and rollout overlap in capacity reviews. Changing the number of pooler processes requires recalculating the total. Increasing queue time does not create capacity.

The pooler is included in the existing database service. This change did not alter database size or replica count or purchase a dedicated pooler. It adds no new recurring subscription; ordinary existing usage still applies. A local pooler shares the primary's failure domain. Dedicated poolers can improve failover behavior but require separately approved costs and compatibility testing.

## Verification

Use the scoped operator wrapper; neither probe emits connection strings, credentials, member rows or raw provider errors:

```sh
python3 scripts/with-secrets.py node --import tsx scripts/probe-database-pool.ts staging --run
python3 scripts/with-secrets.py node --import tsx scripts/probe-database-pool-load.ts staging --run
```

The compatibility probe checks PostgreSQL.js for all three roles and node-postgres for authentication, named prepared statements, verified TLS and transaction-local identity cleanup. The load probe runs 36 read-only clients against staging's existing pooler, holds each transaction for only 250ms, and verifies distinct transaction-local identities. It samples backend counts using one direct, read-only operator connection. It refuses production and a baseline without headroom. It does not query member data.

On October 28 all compatibility checks passed. All 36 concurrent transactions completed in approximately 1.9 seconds; corrected samples showed at most 12 application backends and 15 total backends including two provider superusers and the observer. The initial probe falsely classified the two superusers as auth connections and failed its acceptance check at 14. PostgreSQL superusers satisfy `pg_has_role` for every runtime role; the corrected probe excludes them from application counts. Migration 055 fixes the same issue in the aggregate snapshot introduced by 054 without changing its contract or permissions. A disposable PostgreSQL regression verifies the classification and jobs-only access. Neither new migration has been deployed by the pooling change.

The existing staging application, through Hyperdrive, passed browser login, 24 serial authorized reads, 36 further reads at concurrency six, logout, and old-cookie rejection. Both isolated test identities were removed and absence verified. These are bounded tests, not a complete load, queue-timeout, failover, restore or production certification. Preserve the original failed measurement alongside the corrected result.

## Rollout and recovery

1. Hold the shared deployment lock. Capture live pooler parameters, database tier/replicas, Hyperdrive origins, Worker versions and policies before any mutation. Confirm no provider change is pending.
2. Apply only the named pooler parameters. Wait for the exact provider change request to complete, then read the live parameters again. Do not infer completion from command acceptance or queued settings.
3. Change each existing Hyperdrive origin from 5432 to 6432 while retaining its host, role, database, TLS settings and disabled caching. Inspect any uncertain response before retrying. Provider modification timestamps may change; no other setting may drift.
4. Verify application login/read/logout/revocation and protected health beyond the two-minute stale-intent cutoff. Inspect aggregate errors and connection counts. Keep failed samples and record the actual configuration in the manifest and private deployment record.
5. On a routing regression, restore the captured Hyperdrive origin ports with the same settings, then reverify. This returns to the previous connection-exhaustion risk; it is an incident fallback, not a permanent fix. A Worker rollback alone does not revert Hyperdrive or pooler configuration.
6. A privacy quarantine must follow the guarded original-primary recovery runbook. Never clear it because a pool probe passes or blindly replay an uncertain write.

Pool limits prevent one source of server exhaustion; overloaded transactions can still time out. Durable privacy completion, overload admission, external monitoring and verified failover remain required under [the reliability plan](reliability.md) and [issue #40](https://github.com/porchday/porchday/issues/40).
