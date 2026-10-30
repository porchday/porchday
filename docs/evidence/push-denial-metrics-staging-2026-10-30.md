# Push denial diagnostics staging rollout

Verified October 30, 2026 at 00:16:20 UTC. Tracks #42; this accepts the
diagnostic deployment, not hosted push suppression or physical-device delivery.

Runtime `3c50e2ebe7a6dcf29177867be7dca373e110d4c0` was deployed to staging
version `0d333719-a457-40a5-94a2-8ee4a2371ded`, replacing
`91a0bea2-1327-4806-9c46-dddc1e8133d4`. Release tooling was pinned to
`4d4ed89e7b19bda88a0e469065afebf629ac098c`. All six applicable push/PR CI
checks passed for both commits before provider writes.

The only runtime changes are aggregate observations in the web/native push
processors and their finite telemetry codes. There are no schema, dependency,
binding, public-asset or authorization changes. See
[metric semantics](../operational-metrics.md#confirmed-push-denial-observations).
The exporter remains best effort; missing observations are not success evidence.

## Validation

- 36 SQL-backed push/native/telemetry tests passed, along with API type checking,
  formatting, secret and diff checks.
- The local build verified 53 first-party source files; provider preparation
  checked schema, bindings, isolated queue admission and database pooling.
- Guarded activation recorded 12 continuity samples, zero failed samples, and
  two healthy samples starting after command completion. Maximum start gap was
  2,002.998 ms. Existing allowed sessions remained usable and revoked cookies
  remained rejected across activation.
- Exact synthetic fixture cleanup left zero rows. Immutable denials were
  retained. Final provider state was reconciled and the deployment lease released.
- The staging frontend and assets, isolated topology and four cap-one queue
  consumers remained unchanged. Production stayed at
  `048cd033-4855-4100-9fc2-d1d179fe398b`; production denial writers and cleanup
  remain disabled.

Upload operation `e0a7aa7b-1300-42f6-9ac4-503d3979bd10` and activation
`48e3cae5-01be-4976-88bc-f6a4ef2ca833` are complete. They must not be replayed.
Private evidence retains source hashes, provider snapshots, operation receipts,
continuity observations and cleanup verification; no fixture credentials or
member identifiers are published here.

## Remaining acceptance

A hosted push rehearsal must still demonstrate that the deployed authority
check suppresses delivery while the denied SQL session remains present, with an
owned positive delivery control. These aggregate counters alone cannot identify
a particular job or device. Native device checks, hosted password ordering and
storage/process interruption remain open in the
[production admission audit](session-denial-release-gates-2026-10-29.md).

This sampled staging rollout showed no failed continuity checks. It does not
establish zero downtime between samples, scheduled-release acceptance, provider
failover or the actual monthly 99.99% availability objective.
