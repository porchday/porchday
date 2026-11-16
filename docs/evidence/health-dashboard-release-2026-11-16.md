# November 16 health alerts and private dashboard

## Confirmed fixes

- Stale multi-step privacy recovery can now seal an admitted operation at the existing two-minute stale cutoff, under the existing exclusive SQL lock, and verify canonical commit/terminal/checkpoint evidence before retiring it. This removes the confirmed gap with the three-minute admission expiry. It does not replay interrupted writes or establish their initiating cause.
- GitHub backup monitoring installs its integrity-pinned Undici runtime before executing. PR #243 is merged; non-drill main run 43964958303 passed. GitHub scheduling regularity and owner receipt remain separate verification.
- Private operator dashboard implementation provides audited Access/current-role authorization, guarded readiness, monitor freshness and coverage, sampled retained traces, trace links and explicit unavailable/stale states. The Mac/GitHub live state is not ingested; it links the standing incident log instead.

## Investigation findings and validation limits

Intermittent TCP/TLS/response failures remain unresolved. Two production continuity feed reads received TCP resets on the first recovery release attempt, which rolled back. A separate read timed out on the unchanged baseline. Changing to fresh connections was not supported as a fix by that comparison. The later recovery activation passed 32 continuity samples and finalized after resuming the same durable operation. Original failures remain retained; no alert thresholds or continuity deadlines were relaxed.

Hosted dashboard validation found an unsupported Workers redirect mode that Node-only tests missed. Readiness now uses the existing in-process health reader. Monitor status uses a scoped service binding and manual redirects with explicit rejection. A real workerd regression verifies bound-service JSON and redirect rejection. Earlier public-routing explanations were incomplete: the unsupported redirect mode prevents dispatch before routing.

The production recovery fix is source `10feac8e09fe0a4496939df22f80c551f277bf28`, version `fce884a2-3cea-4980-a995-6ce1bfcab0a9`. Exact-source full/iOS/macOS checks passed. The dashboard backend is deployed in production from `ee358d69f71c0f49ca3bff957d8f5c8de857f6dd`, Worker `8a692f8f-3b8e-403e-b74a-8c46eae29561`, with 15 continuity samples and zero failed samples. Staging backend is `39135eba48e5f9dbbce3ecb588390033be8c4229`, Worker `34ddf335-5522-4937-b186-e323fd5138d2`, with 14 continuity samples and zero failures. Synthetic fixture cleanup verified zero remaining rows. Authenticated staging readiness, monitor data and trace navigation passed.

Frontend candidate source is `50a9218293b69e73b51f853a9d073a0316e11f4b`. Production frontend Worker `22b559bf-b8d5-4160-bee9-9424e5b51ce1` passed retained-browser acceptance and 18 continuity samples with zero failures, followed by zero-row synthetic cleanup. Canonical member routes, legacy redirects/PWA navigation and anonymous operator-route denial passed. Production owner-browser verification requires a fresh Cloudflare Access sign-in after the previous session expired; it remains pending, not passed.

Exact-source production checks:

| Source | Full CI | Secret scan | iOS | macOS |
| --- | --- | --- | --- | --- |
| API ee358d6 | 43969205422 | 43969205354 | 43969205363 | 43969205375 |
| Frontend 50a9218 | 43963353040 | 43963353065 | 43963353042 | 43963353324 |

All listed runs succeeded. Duplicate native jobs for the PR aggregation branch and staging-only composition were canceled to free the Mac runner; those canceled runs are not claimed as passing deployed-source verification. Native parity remains enforced by the maintained production activation CLI.

The first production frontend attempt entered attention-required before its initial verification and closed the original retained browser context. Its incomplete browser acceptance was explicitly rejected and the maintained controller finalized rollback. A later preparation timed out on a synthetic sign-in before activation; its owned fixture was reconciled and removed without replaying the sign-in. Both failures remain recorded; neither is a successful rollout.

No native binary distribution, physical-device Access acceptance or measured 99.99% availability is claimed. Diagnostic counts and p95 describe preferentially retained error/slow evidence, not the complete traffic population. Missing monitor observations do not count as successes.
