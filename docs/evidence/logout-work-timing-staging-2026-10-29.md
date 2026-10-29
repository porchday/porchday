# Logout transaction timing staging verification

Source `6373a6c789e05c9774ce0c59a17c56fd2676fa56` adds numeric timing around existing logout transaction boundaries: pool acquisition, transaction setup, identity lock, repeated authorization, handler, commit and rollback. Operation order, authorization, deadlines and ambiguous commit handling are unchanged. The correlated summary retains its existing 15 fields. New subphases are independently sampled aggregates, not individually correlated request evidence.

The exact source passed push CI 40935043885 and PR CI 40935050768, including browser and secret checks. The diagnostic branch passed 895 database-backed tests and 22 crypto tests; the main-aligned patch separately passed 36 focused tests and API typecheck.

Guarded staging activation completed at 18:59:52 UTC on October 29 as version `6b3c5098-1b98-4d00-b01d-b3a920acfb0e`. All 11 continuity samples passed, including two after the release command completed. Existing allowed sessions and revoked-cookie rejection were preserved. Exact fixture cleanup left zero rows. Production, frontend assets and staging writer/cleanup enablement were unchanged.

Staging's enabled writer bypasses the legacy transaction. A separately reviewed legacy-path candidate was uploaded but its activation preflight stopped when production's independent monitor detected renewed journey failures. Read-only reconciliation confirmed no fixture, lease or activation had started and the candidate remains inactive. The failed attempt is retained. That original preflight failure remains retained. A fresh acceptance run is described below; production promotion remains unverified.

At 19:01:55 UTC production again exceeded the ten-second journey deadline. Login and reads succeeded, logout exhausted the remaining budget, and revocation could not be observed. The GitHub outage alert was delivered at 19:02:25. Fresh server telemetry included a 7,773 ms logout, with delay distributed across authorization, journal registration and transaction work. No individual server point is correlated to a monitor cycle. Five direct read-only database snapshots at 19:04:26–31 found seven idle connections and one active observer, no observed lock waits, and 32–34 ms warm queries. These snapshots do not measure the Worker/Hyperdrive path or exclude transient waits. Root cause remains under investigation in [issue #55](https://github.com/porchday/porchday/issues/55).

This is staging code-continuity evidence, not a latency improvement or a 99.99% availability claim.

## Legacy path and restoration

After five healthy production probes, a fresh, separately reviewed acceptance run reused the inactive candidate without re-uploading it. At 19:10:14 UTC, staging `e03216d6` passed all 12 continuity samples, including two after command completion. Logout returned 200 and the old cookie returned 401; exact cleanup left zero fixture rows. Only the staging writer flag was temporarily disabled; cleanup and denial readers remained enabled.

Read-only aggregate queries subsequently observed all six successful transaction phases: acquisition, setup, identity lock, repeated authorization, handler and commit. Initial queries were incomplete; delayed ingestion and independent sampling mean missing points cannot be treated as zero duration or evidence of skipped work. No hosted rollback failure was injected; that failure path remains covered by local tests.

The separately reviewed restoration completed at 19:12:28 UTC as version `40443794-69fe-4ffa-92d5-06e9d811905f`, retaining runtime `6373a6c`. Both staging writer and cleanup are again enabled. Its continuity check and exact cleanup passed. Production is unchanged.

The external production observer recorded 16 failed journeys from 19:01:55 through 19:07:15, with one healthy observation inside that interval. Consecutive recovery observations began at 19:07:35, and the recovery notification was delivered at 19:08:20. This describes sampled journeys, not an exact continuous outage interval. The initiating cause remains unresolved.
