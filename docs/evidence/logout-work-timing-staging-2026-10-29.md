# Logout transaction timing staging verification

Source `6373a6c789e05c9774ce0c59a17c56fd2676fa56` adds numeric timing around existing logout transaction boundaries: pool acquisition, transaction setup, identity lock, repeated authorization, handler, commit and rollback. Operation order, authorization, deadlines and ambiguous commit handling are unchanged. The correlated summary retains its existing 15 fields. New subphases are independently sampled aggregates, not individually correlated request evidence.

The exact source passed push CI 40935043885 and PR CI 40935050768, including browser and secret checks. The diagnostic branch passed 895 database-backed tests and 22 crypto tests; the main-aligned patch separately passed 36 focused tests and API typecheck.

Guarded staging activation completed at 18:59:52 UTC on October 29 as version `6b3c5098-1b98-4d00-b01d-b3a920acfb0e`. All 11 continuity samples passed, including two after the release command completed. Existing allowed sessions and revoked-cookie rejection were preserved. Exact fixture cleanup left zero rows. Production, frontend assets and staging writer/cleanup enablement were unchanged.

Staging's enabled writer bypasses the legacy transaction. A separately reviewed legacy-path candidate was uploaded but its activation preflight stopped when production's independent monitor detected renewed journey failures. Read-only reconciliation confirmed no fixture, lease or activation had started and the candidate remains inactive. The failed attempt is retained. Legacy timing ingestion and production promotion remain unverified.

At 19:01:55 UTC production again exceeded the ten-second journey deadline. Login and reads succeeded, logout exhausted the remaining budget, and revocation could not be observed. The GitHub outage alert was delivered at 19:02:25. Fresh server telemetry included a 7,773 ms logout, with delay distributed across authorization, journal registration and transaction work. No individual server point is correlated to a monitor cycle. Five direct read-only database snapshots at 19:04:26–31 found seven idle connections and one active observer, no observed lock waits, and 32–34 ms warm queries. These snapshots do not measure the Worker/Hyperdrive path or exclude transient waits. Root cause remains under investigation in [issue #55](https://github.com/porchday/porchday/issues/55).

This is staging code-continuity evidence, not a latency improvement or a 99.99% availability claim.
