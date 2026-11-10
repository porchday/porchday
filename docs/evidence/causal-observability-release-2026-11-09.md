# Cloudflare causal observability release — November 9, 2026

Tracked in #12 and PR #212. Telemetry remains in Cloudflare. Operational traces exclude member content, secrets, raw SQL, storage keys and raw URLs; separately consented device recordings remain separate.

## Deployed versions

| Environment / component | Cloudflare version | Reviewed source |
| --- | --- | --- |
| Production API | `52dcf325-8d42-4013-926c-88ced501349a` | `dd342aa6a4ffb716a0463714d68f2b19cfcde31d` |
| Production edge / UI | `c2619a62-81e3-4eca-be9b-789bc649896f` | `f997352d192a109fedc7c77676fca6195e160135` |
| Production monitor | `cddcdfe2-ee4b-48c9-ba4d-ff96239222cd` | `f997352d192a109fedc7c77676fca6195e160135` |
| Staging API | `6425d91b-a4db-412e-87a6-a74217285ac9` | `fa6295d167cca229d0716e1c17dcbefe8a11631b` |
| Staging edge / UI | `3fa2316f-0a25-406d-a2cf-c48dbaa7907f` | `f997352d192a109fedc7c77676fca6195e160135` |
| Staging monitor | `e061b2a4-de70-40a1-8c2b-84ca9f259026` | `f42ecc6a01fb64d288bc41281cf2fa1740346bc4` |

Migration 0003 applied additively in both environments. Runtime branches preserve each environment's existing journal/denial behavior and staging monitor read-status recovery. The external Mac monitor now includes trace correlation and finite transport diagnostics; its existing 20-second cadence and incident dispatcher are retained. No recurring AI polling was added.

The PR also merges upstream invitation work (#213); that unrelated application change is **not** included in these pinned release artifacts. Configuration and bounded browser CI setup follow-ups do not change their source pins.

## Verified

- Exact-source full CI and production iOS simulator/macOS automated parity gates passed. Activation used maintained native-gated tooling at `cce72b4ce5e486b5413ffa0b7cac43dadcb471e6`.
- Staging and production API, edge and monitor activation continuity had zero failed samples and zero remaining fixture rows. Production monitor had 16 continuity samples.
- Hosted Chromium and WebKit exercised actual encryption/decryption with browser-to-API/database parent links, consent clearing and denial of ordinary-member investigation access.
- Actual scheduled queue producer links resolved to recorded send spans; PostgreSQL and R2 spans were retained.
- Hosted encrypted-photo publish/delete, draft restore, update deferral, deletion retry, diagnostics consent/stop/delete, PWA/domain routing and deployed asset identity passed in both environments.
- Local real PostgreSQL, Workers R2/D1, privacy/budget/context isolation and failure-path tests passed. Native R2 stream handoff preserves response framing.
- Fresh production exports continued after the final monitor deployment. At 06:18 UTC November 10, the five-minute telemetry window contained 112 successful exports and no reported exporter-failure/drop counters. This is pipeline evidence, not an application error-rate measurement.
- A real health-check R2 read failed, retried after approximately 1.12 seconds, then succeeded in 77 ms. The request returned HTTP 200 in 1.34 seconds; its correlated external journey passed all checks. This establishes successful recovery, not Cloudflare's internal failure cause.

Private provider receipts, fixture evidence and trace identifiers remain in operator-only release artifacts; no member diagnostics content is published here.

## Remaining verification and limits

Keep #12 open with `needs verification`: physical iOS/macOS checks, positive staff UI acceptance with a real Cloudflare Access identity, isolated hosted exporter-failure/recovery drill, and a controlled overhead comparison remain outstanding. Local authorized-query/audit and exporter-isolation tests passed; they are not substitutes for those hosted/device checks. No native binary was distributed in this rollout.

Provider internals and native OS internals remain opaque. Long traces can reach the 160-span bound; omission counts are explicit. An R2 stream handoff does not prove client receipt of every byte. Sampling/export budgets are bounded per isolate, not an account-wide cost ceiling. Recent production samples showed zero server errors but logout p95 near five seconds; healthy availability is not uniformly fast performance. Photo scroll/layout/cache work remains separately tracked in #168.
