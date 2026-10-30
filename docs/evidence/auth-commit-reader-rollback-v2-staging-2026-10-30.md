# Staging API reader rollback acceptance — October 30, 2026

A fresh staging API rollback rehearsal passed at 01:57:15 UTC using controller
`ad285661b52b64ff5cdb1542eafcd0d78492923d`. The normal controller restored the
compatible baseline after an isolated observer browser exception, with 15 healthy
continuity samples and exact fixture cleanup. This does not erase or explain the
[previous rehearsal's readiness transport failure](auth-commit-reader-rollback-staging-2026-10-30.md).

## Preconditions and scope

All six exact-source CI checks passed: Verify Porchday 40988079964/40988075068,
browser 40988079918/40988075052, and secret scan 40988079952/40988075044.
Local validation included 62 continuity/observer tests, both release TypeScript
configurations, formatting, secret and diff checks. Fresh preparation checked the
54-file runtime provenance, local upload dry-run, six database routes, configured
pooling limits, provider inventory, schema count 58 and an empty pending journal.
The original failed run's verified fixture cleanup was required before new
fixtures could be created.

One initial read-only preflight failed without a retained error category. A
separate read-only reconciliation verified all preconditions; the failed result
remains recorded. Activation preparation then encountered a preexisting empty
continuity directory, created earlier in local preparation. No activation or
fixtures existed at that point. Separate read-only reconciliation checked all
four execution directories were owned, private and empty, reverified assets and
provider state, and completed a new activation manifest. The original plan and
failed preparation records were preserved; no failed write was replayed.

The installed watcher remains at `a589e7a5fbcb7b7010da15e5ddcea0757e3bede4`.
Independent traversal of both source trees after TypeScript type erasure verified
that all 11 runtime modules reachable from its entrypoint were byte-identical.
The changed continuity probe is referenced only through an erased type import in
the watcher's dependency graph. Runtime hashes and live watcher readiness were
rechecked before execution.

## Observed rollback and continuity

- Upload operation: `ecb04464-b5d1-4e0e-9279-386f4b15ee7a`.
- Activation operation: `e4897fb3-d0fa-478d-8690-9b623505cd21`.
- Candidate: `b38e9757-0d3b-4ce8-b031-5e0da614b3cd`.
- Baseline and reader floor: `fd35aa2e-f881-46fb-a596-e3d6eb7defb1`.
- Runtime for both versions: `89f03970422e7869002703840b5067e5f585b11e`.

The candidate was uploaded and verified inactive before activation. Served
frontend assets were identical throughout. Only the observer's fresh browser
context received the injected exception. Its report at 01:56:51.625 UTC confirmed
one fresh page error, zero old-context page or MIME errors, retained old document,
matching new document and successful cold lazy-module retrieval. This deliberately
failed browser gate triggered the ordinary rollback path.

Terminal rollback was recorded at 01:57:06.255 UTC, 14.630 seconds after the browser
report. That interval measures report-to-terminal recovery, not outage duration.
Fifteen continuity samples spanned 01:56:41.463–01:57:10.105 UTC. All authorized
profile, empty-feed, revoked-cookie and protected-readiness checks passed. Two
sample starts occurred after command termination; maximum start gap was
2002.93 ms. This establishes no observed failures within this sampled scope,
not continuous observation of every request or all client types.

Exact SQL cleanup verified zero remaining fixture rows. Temporary cookie files
and the retained fixture were removed. Provider inventory was reverified after
cleanup and the deployment lease released. Canonical baseline, reader floor,
schema count 58, frontend and isolated cap-one queues were preserved. Recovery
remains enabled; the privacy commit writer remains absent. Production was neither
deployed nor reconfigured.

## Independent notification

The existing Mac watcher delivered the scoped notification drill through GitHub
workflow run 40988856136. Read-only verification found exactly one matching
[bot comment](https://github.com/porchday/porchday/issues/3#issuecomment-6513060597),
verified the event digest against persisted delivery state, and observed two
subsequent polls at 01:57:49.224 and 01:58:09.402 UTC with zero pending alerts or
errors. This proves transport to the repository issue, not owner inbox receipt.

## Remaining work

The earlier transport failure remains unexplained. The new safe diagnostics are
available for future failures; a passing run cannot retroactively identify it.
Hosted marker-only crash recovery, writer/load/cost gates, production rollout and
actual scheduled feature-release adoption remain outstanding. Browser observation
covers unauthenticated old-tab assets and fresh login rendering; authenticated API
continuity is separate. Installed/native client coverage, owner inbox receipt and
Mac power/network redundancy remain unverified. Monthly 99.99% availability still
requires the full observation period.
