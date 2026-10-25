# Database and storage visibility

The operator uses PlanetScale's native **database → Metrics → branch `main`** view for each environment. Review a consistent interval for primary/replica CPU and memory, IOPS, storage, active/idle-in-transaction connections, PgBouncer waiting clients, WAL archival age/failures and replication lag. Compare storage/egress trends over days as well as a short incident window. Select the actual environment and server; a staging sample does not establish production capacity. These panels are documented provider functionality, not measurements newly claimed by this runbook. [PlanetScale cluster metrics](https://planetscale.com/docs/postgres/monitoring/metrics)

Do not enable query-text capture, extra provider diagnostics, logs or broad telemetry exports to obtain these aggregate metrics. Review existing provider metadata retention/access controls separately. CPU and disk figures are infrastructure metadata, not private content; query samples can contain identifiers and require a separate privacy review.

The fixed read-only helper provides a small SQL-side snapshot without printing the connection URL, query text, role names or member rows:

```sh
python3 scripts/with-secrets.py npx tsx scripts/database-capacity.ts staging
python3 scripts/with-secrets.py npx tsx scripts/database-capacity.ts production
```

It checks the manifest branch-qualified PlanetScale connection, requires verified TLS, runs a read-only transaction with a five-second statement timeout, and returns timestamp, database bytes and connection counts. The current monitoring connection itself is included in active/total counts. `pg_database_size` excludes external media, backups and server-wide WAL/filesystem overhead; `max_connections` is a server setting, not a promise of usable application capacity. PgBouncer/provider quotas can impose other limits. The helper is an explicit operator tool, not a new database credential or periodic query in the monitoring Worker.

Record sanitized snapshots with their UTC interval and compare trends; do not infer growth from a single point. For private R2 media, backup and journal usage, use each named bucket's native Cloudflare Metrics/usage view and compare with the expected seven-day backup lifecycle and durable deletion backlog. Do not list object keys or inspect ciphertext to measure growth. Cloudflare account budget alerts exclude fixed subscriptions, and usage reporting may lag; reconcile billing separately with `docs/cost-ledger.md`.

Until a measured pilot baseline and operating budget are approved, there is no certified CPU, storage or connection threshold. Escalate sustained saturation, increasing wait/idle-transaction counts, WAL failures or accelerating growth to the named operator; use existing invitation/upload/posting incident controls when appropriate. Changes to tiers, storage limits, retained backups or telemetry require their normal review. Do not silently delete permanent media, release privacy quarantine or increase spending merely to clear a chart. The current database tiers and configured 50 GiB storage ceilings are resource settings, not proven workload capacity.

Native provider dashboards supply CPU/memory/disk visibility without a new paid monitoring service or broad provider token in the independent monitor. Automatic cross-provider capacity alerting, named responder/backup ownership, actual budget-alert receipt and a sustainable operating budget remain admission/operations decisions; this runbook does not pretend they have been verified.

## Read-only helper verification

The helper executed against the existing branch-qualified, TLS-verified operator connections on October 25, 2026. Staging at 19:26:09.630 UTC returned 12,605,107 database bytes; production at 19:26:10.423 returned 10,860,211. Both snapshots reported 13 database connections, one active connection, zero idle-in-transaction connections, and server `max_connections=25`. No application content, identities or query strings were read, and no database/provider configuration changed. These point-in-time aggregates do not establish a growth rate, usable connection headroom, filesystem utilization or pilot capacity. CPU, memory and provider filesystem charts were not independently sampled during this check.
