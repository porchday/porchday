# Log-driven performance improvements — November 9, 2026

Implemented and deployed through [PR #216](https://github.com/porchday/porchday/pull/216); tracked in #9, #55 and #168.

## Evidence and selected opportunities

Production sampled 15-minute aggregates before implementation showed logout mean 3,858 ms (p95 4,879 ms), registration mean 1,162 ms and R2 writes mean 301 ms. Retained browser samples showed repeated photo-conversation reads around 875–947 ms and unchanged notification-key registration around 900 ms. Logout traffic includes synthetic monitors; retained browser traces favor slow/error cases and span the earlier photo-cache rollout. These are actionable hot spots, not unbiased population rankings.

1. **Journal registration:** immutable intent and commit-scope writes run concurrently. Both outcomes are drained, and both must succeed before SQL preparation or control registration. Guards, receipts, CAS, fencing, revocation and recovery remain intact. A five-sample controlled 100 ms/write experiment reduced registration from 306 ms to 205 ms; this is not a production latency guarantee.
2. **Photo conversations and cache retention:** initial reads/decryption wait until the conversation is within 400px of the viewport. Loaded state stays mounted across scrolling. Actual photo-interaction POST/DELETE routes now preserve cached photo bytes; the earlier exemption used different endpoint names. Authorization failures still invalidate the cache, and access/content mutations remain invalidating.
3. **Notification enrollment:** an acknowledged unchanged registration is remembered in component/session memory for at most 15 minutes. Local/native trust pins still refresh each minute. Subscription/generation/config changes trigger registration; failed requests and inactive late completions are not remembered. The controlled 15-minute unchanged-session test makes one registration instead of 15. No authorization or delivery result is cached.

## Live versions

| Environment | API source | API version | Edge/UI version | Retained-asset rollback version |
| --- | --- | --- | --- | --- |
| staging | `a09bb07d251f146d31428fb61fff0bc44df164a3` | `ffacb10c-2735-4c2c-ab58-6c550248c92a` | `07fd9a19-fa45-4347-9408-834fb4013b4b` | `03ceb0da-0311-498c-996c-99b4dc50f453` |
| production | `40015c0640601d11728f1e77f4cbdd9b48f80ec1` | `0a5a927e-ca08-4f34-bee8-c390108e62df` | `77cd05bc-9fc0-40c5-b43b-39b35f88c856` | `cbacdb2d-9be8-4f17-94c2-cf52db910b6d` |

Frontend source: `1f35226b6dcbe34bc4f79e6d7d017afb1e5710f7`. Production UI acceptance: 2026-11-10T07:39:57.689Z. Existing environment-specific backend repairs and schemas are preserved. Activation used maintained native-parity-gated tooling `cce72b4ce5e486b5413ffa0b7cac43dadcb471e6`.

## Validation

- frontend: [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42774461245), [Secret scan](https://github.com/porchday/porchday/actions/runs/42774461511), [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42774461322), [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42774461326).
- staging: [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42773483017), [Secret scan](https://github.com/porchday/porchday/actions/runs/42773482754), [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42773482755), [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42773482761).
- production: [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42773485983), [Secret scan](https://github.com/porchday/porchday/actions/runs/42773486057), [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42773486002), [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42773486257).

Focused tests cover overlapping blocked writes, either immutable-write failure preventing admission, bounded enrollment refresh and invalidation, and actual photo-interaction cache preservation. Chromium/WebKit verify no off-screen conversation reads, loading on approach, no scrolling refetch, account replacement, and the existing photo layout/cache/access/expiry checks. Hosted staging/production checks passed authenticated continuity and logout/revocation, actual encrypted-photo warm scrolling and HEAD authorization, encrypted drafts, safe updates, routing, settings/diagnostics consent, invitation regression and fixture cleanup. All recorded fixture rows were removed. Existing-tab forward/rollback asset checks passed.

The independent production monitor recorded 8 healthy samples across 140010 ms after activation, with zero failed samples.

## Live timing and limitations

Equal before/after windows span 5.8 minutes each. Weighted operational samples include synthetic monitoring and are observational, not a controlled experiment.

| Measure | Before mean ms | After mean ms | Before p95 ms | After p95 ms | Observed points before/after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Logout request | 3769 | 3321 | 4881 | 3779 | 20/26 |
| Journal registration | 1124 | 814 | 1318 | 979 | 9/9 |

Physical iPhone/Mac scrolling, longer-session memory pressure and user-device end-to-end latency remain unverified under #9/#168/#49/#114. Source builds and simulator/macOS checks are available; no new signed native installer, TestFlight build or App Store release is claimed or required for the shared hosted UI change. Provider tail latency and total availability remain ongoing monitoring concerns.
