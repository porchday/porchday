# Verified staging monitor activation

The monitor read mitigation at `685d891628f57b12c460db5b9fc4e0d390e0d6b9` is deployed on staging as `a872ae99-3890-428e-9a87-04e3d27e4f1a`. Tooling `1b2de1e8f51b86ce37378e0883b41fcfa92ee7b6` passed exact push Verify40896374494, Secret40896374497 and browser40896374414.

Corrected upload operation `1b13ba2d-0394-4469-9db7-19374f376032` dispatched once and verified candidate artifacts, source provenance, resources, schema and inactive routing. Activation `99b86ff6-d97c-460f-88e2-d31a1a5af180` completed at 2026-10-29 15:01:42.552 UTC; fixture cleanup and final inventory acceptance completed at 15:01:47.981 UTC.

The retained-session observer recorded 14 samples, zero failures, two post-command samples and a maximum start gap of 2004ms. It observed both an allowed session and a revoked cookie across the activation. Both synthetic accounts were removed with zero matching fixture rows remaining; denial records were retained. The observer itself was locally exercised against API/production-monitor drift, foreign leases, fixture changes, one-time lease handoff and candidate/post-command coverage before hosted use.

Public monitor reads before authorization and after activation retained history origin `2026-10-27T22:09:00.000Z`, ready metrics, operational status, and advancing expected-minute counts without losing recorded passes/failures. This is aggregate hosted-history evidence, not byte-for-byte storage identity. Exact local baseline/candidate/baseline storage compatibility was separately verified.

Application staging version `93259d5e-7407-484e-858b-7e72a7c85595`, production deployments, assets, queues, schedules, schema and security flags remained unchanged. Canonical staging monitor version/source were updated only after verification; the shared lease was released. Private evidence resides under `monitor-freshness-20261029/corrected-upload`; issue8 comment6500294126 was published and read back.

## Production recovery remains open

Three bounded production status GETs at approximately 15:02 UTC returned503/unknown without availability history. Recent independent application checks passed login, authorized reads, logout and revoked-cookie denial, but monitor freshness failed. The normal monitor activation gate correctly requires fresh readable baseline history; no production activation was attempted.

A retained hourly observation at 12:58 UTC contains production history origin `2026-10-27T22:13:00.000Z`, 2326 expected minutes, 1690 passed, 636 failed, zero unknown and ready metrics. It is historical evidence, not a fresh baseline or proof that the monitor is healthy now. If fresh reads remain unavailable, an explicit incident-recovery path is needed: pin the historical evidence and current failure, bound its age, require unchanged storage/schema and staged compatibility, preserve ordinary release gates, and require fresh candidate history with no reset/lost observations before declaring recovery. Do not fabricate a healthy baseline, reset history, replay scheduled ticks or treat these readiness aggregates as the complete user-journey SLO.
