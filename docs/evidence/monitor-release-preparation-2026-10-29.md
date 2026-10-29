# Monitor release preparation

The status-read mitigation at `685d891628f57b12c460db5b9fc4e0d390e0d6b9`
was built with Wrangler 4.152.0 using the staging monitor configuration in dry-run
mode. The six first-party source files in its source map match immutable Git
blobs. Compared with deployed monitor source
`005454607c98ffdb7c430a947bedb4586a14a45b`, runtime changes are restricted to
`apps/monitor/src/index.ts` and the new `read-status.ts`.

Read-only provider inventory matched the current canonical record, including
staging monitor `e091eb91-ce05-4813-a68c-ced1b4c7a98d` and production monitor
`fb6b480a-820e-4e8f-82f4-580a556589a7`. No upload or activation was performed.
Private preparation receipts retain bundle hashes and the complete inventory.

## Release-tooling gap and change

The maintained upload/activation tooling originally accepted only application
and edge Worker names. Inactive uploads now also recognize the two explicitly
named monitor Workers. They retain the same exclusive lease, durable one-shot
intent, CI checks, schema fingerprint checks, provider inventory checks,
configuration/resource verification and read-only reconciliation. Source-map
provenance selects monitor source rather than interpreting `src/` as API source.
The database fingerprint remains a guard against collateral change; the monitor
upload does not migrate the database.

Upload scope is separate from activation scope. Existing application activation
still rejects monitor Workers. Monitor activation requires explicit handling of
monitorVersions, monitor source provenance, persisted observation/history
compatibility, monitor-specific verification and canonical finalization. Do not
bypass that gap with an application Worker identity or an old deployment helper.

All 53 focused upload tests passed, including monitor/API success and failure
reconciliation, immutable proof replay, canonical/resource/schema/source
protection, lease behavior and process behavior. Release TypeScript and whitespace
checks passed. These tests do not prove a hosted monitor upload or activation.

Next: finish exact-source CI, prepare the monitor-specific activation path with
state preservation and rollback verification, then upload and activate staging
through the maintained safeguards. #8 and #3 remain open. The production monitor
freshness incident is not resolved by this preparation.
