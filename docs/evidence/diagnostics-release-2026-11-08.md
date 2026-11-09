# Consented diagnostics release — November 8, 2026

PR [#197](https://github.com/porchday/porchday/pull/197) and its staging-discovered
routing fix [#198](https://github.com/porchday/porchday/pull/198) are deployed.
Tracking: [#196](https://github.com/porchday/porchday/issues/196).

Settings → My data now offers per-device detailed diagnostics, with separate
explicit consent for selected visible content and draft input. Both are off by
default. Users can view, stop and delete recordings. Credentials, encryption keys
and recovery screens remain excluded. Authorized operator reads require Cloudflare
Access and an active builder staff role; reads are audited before content returns.

The first staging UI check found that `/diagnostics` was omitted from member-route
classification. The corrected build includes regression coverage and passed the
recording timeline flow before production promotion.

## Verified deployment

- Staging frontend: `842b2cf7-f0fc-49d8-ad67-924bd5f656a1`, source `cdbc4b833b5c3c60dc97de8e7076ab3f5668df22`.
- Staging API: `465e9930-2a94-4b71-aa07-b9c30b897b99`, source `050335abf80b40575ffe3b61e588a259ec425a33`.
- Production frontend: `f1c7dfd4-bc51-4433-9189-ab58b0975941`, source `cdbc4b833b5c3c60dc97de8e7076ab3f5668df22`.
- Production API: `88ff5027-0438-484a-8dc8-1139942d2019`, source `f1a4854a9b6dea7cf46aee7a5eccb09c513fcc24`.

Environment-specific backend branches preserve the previously deployed auth/session
runtime. Their API delta is confined to diagnostics and supporting tests. Additive
D1 migration `0002_diagnostics.sql` was applied before API activation; PostgreSQL
schema fingerprints were unchanged. Maintained release upload/activation tooling
verified artifact provenance, retained assets, rollback compatibility, active
provider state and authenticated session continuity.

## Acceptance evidence

- Local route, Chromium/WebKit collector and SQLite API tests: 15 passed.
- Exact-source web/API CI, iOS simulator tests and macOS build/tests passed.
- Hosted staging and production: default-off state, explicit content consent,
  durable/idempotent event delivery, server outcome correlation, nonstaff denial,
  stop and deletion passed using synthetic accounts.
- Actual deployed mobile UI: consent survives navigation accurately, recording
  timeline loads, stopping and deletion work. Draft navigation/reload recovery,
  safe automatic updates and settings layout also passed.
- Old open tabs, rollback assets, root routes, legacy redirects and simulated
  native-bridge browser checks passed. Synthetic fixtures were removed.
- Post-release production monitor: 9 healthy samples over 160 seconds, no failed samples.
- Final provider/schema audit passed at `2026-11-09T06:02:11.119Z`.

The shared web collector is used by the iOS/macOS thin shells; no new native binary
is required for this release. Physical-device acceptance and a real authorized
operator reading a consented recording remain follow-up verification in #196.
They are not represented as completed. Automated operator audit/fail-closed tests
passed; hosted checks verified unauthenticated operator access is denied.

Private release evidence is retained under `diagnostics-release-20261108` and
`diagnostics-v2-release-20261108`; recording contents and credentials are not
published here. Diagnostics are bounded and expire: they cannot guarantee recovery
of events lost to device shutdown, storage eviction or prolonged offline periods.
