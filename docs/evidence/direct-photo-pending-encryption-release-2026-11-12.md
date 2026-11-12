# Direct photo sharing with pending encryption recipients

Implementation: [PR #225](https://github.com/porchday/porchday/pull/225), source `85ced6da58dc50970eb7722b4a6b2d4986fc11be`, merge `6dc19affa1715237b48809ea4ccf0b3b93cf33c8`. Tracking: [#185](https://github.com/porchday/porchday/issues/185).

## Root cause and behavior

The November 8 fix explicitly covered posts and attachments. Standalone photo/video publication still rejected pending audience members in the vault and API photo-envelope validator. The screenshot's No album / Photos & videos flow uses that independent path.

Direct social photos/videos now encrypt to every ready eligible device. Additive migration 079 retains pending direct-connection eligibility against the original connection, including future-only connections present at publication. This metadata grants no read access. After recipient setup, the owner's unlocked app can perform encrypted catch-up while another member remains keyless. Later future-only connections do not gain older photos. Blocks, relabeling, disconnects, grant deletion and member deletion remove pending eligibility.

Exact ready-recipient sets, fingerprints, epochs, author, expiry and current audience checks remain enforced. Album administration remains unchanged. The shared Swift vault implements equivalent publication and photo-history behavior; default iOS/macOS web shells use the shared web fix without a new signed binary.

## Verification

- 21 real-OpenPGP/RLS independent-photo HTTP tests passed on both full and preserved schemas, including the new pending-recipient regression.
- 29 social HTTP tests passed; one optional old-module compatibility test was skipped. 18 photo database/web photo/video tests passed. Web/API types and text checks passed.
- Chromium composer/calendar/draft checks and retained-asset forward/rollback checks passed.
- Hosted Verify Porchday and secret scans passed on the frontend and both preserved API candidates. Frontend iOS ran 153 unit tests with four skipped and zero failures, plus three passing UI tests. Native verification is not a claim of physical-device acceptance.
- Staging direct HTTP checks published standalone photos with two keyless future-only recipients. Real initial device registration then enabled encrypted photo/media catch-up while the other member remained keyless. Blocking and disconnect revoked access; synthetic fixtures were removed.
- The actual staging mobile-sized composer published two direct photos to Friends & Family while a future-only connection had no keys. Pending eligibility was retained and no blocking message appeared. Synthetic fixtures were removed.

## Release preparation observations

Activation preparation stopped before activation on an archived Cloudflare placement target's opaque `id: 2`, which fresh provider observations omit. The region/type and every other resource field matched. A narrowly checked comparison was recorded; the original failed preparation was retained and the verified inactive upload reused. Shared normalization follow-up is recorded on #3.

The first hosted composer test lacked photo dates in its synthetic JPEG files. Required browser validation prevented submission; no photo or media publication occurred. The synthetic account was cleaned up, the fixture supplied explicit dates, and the new run passed. This was a test-fixture failure, not an encryption failure.

Private operational evidence: `artifacts/private/pending-photo-20261112` (not committed).

## Production delivery

Both environments passed the direct encrypted-publication/catch-up regression, real mobile-sized composer test, exact asset and route checks, native-bridge browser smoke, and authenticated session continuity. Synthetic fixtures were removed. These browser checks do not claim physical-device validation.

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API | `d504251d59b7a3a000f31bc262342e1bd6f94dd5` | `020d99e8-c620-415b-a8b9-f529a2192828` |
| staging | Frontend | `85ced6da58dc50970eb7722b4a6b2d4986fc11be` | `67e8810b-d8ee-4343-ac62-b62bbf9f9714` |
| production | API | `6797153537ce85e0970ce59de95add1f168e4c9a` | `65b7f79f-5762-44b7-83b5-9d5775766a60` |
| production | Frontend | `85ced6da58dc50970eb7722b4a6b2d4986fc11be` | `af71ee65-69b2-4fa8-b0cb-ae36d70bcfb4` |

Exact-source production checks: [API Verify](https://github.com/porchday/porchday/actions/runs/43248711403), [API secret scan](https://github.com/porchday/porchday/actions/runs/43248711307), [API iOS](https://github.com/porchday/porchday/actions/runs/43248711187), [API macOS](https://github.com/porchday/porchday/actions/runs/43248711157); [frontend Verify](https://github.com/porchday/porchday/actions/runs/43248664614), [frontend secret scan](https://github.com/porchday/porchday/actions/runs/43248664562), [frontend iOS](https://github.com/porchday/porchday/actions/runs/43248664530), [frontend macOS](https://github.com/porchday/porchday/actions/runs/43248664843). All passed. Production API iOS had 151 unit tests with four skipped and zero failures, plus three passing UI tests; its macOS run passed 85 tests.

Independent post-release production monitoring passed with 8 healthy samples over 140009 ms and zero failed samples. Final fresh provider/schema/native-parity audit passed at `2026-11-12T16:17:47.035Z`; active provider state matches the canonical release record and no release lease remained at the audit. A separate, verified inactive staging upload from the logout-latency release was present; its upload proof was checked and its sole `latest`-version difference recorded. Production state was unchanged.

No signed native binary was distributed for this release. Default web-shell installations receive the shared UI update. Catch-up requires the author’s unlocked app after the recipient completes setup. Physical-device acceptance remains separately tracked in #49 and #114.
