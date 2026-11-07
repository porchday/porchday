# Direct videos and 10 GB storage — November 7, 2026

Share → Photos & videos now publishes videos without a post. Total stored media is 10,000,000,000 bytes per person. Per-video limits remain 1 GiB source, 250 MiB prepared and 10 minutes. [Design](../../design/direct-videos-and-storage.md), [PR #182](https://github.com/porchday/porchday/pull/182), [issue #181](https://github.com/porchday/porchday/issues/181).

## Deployed sources

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | api | [2dc9f19c434d](https://github.com/porchday/porchday/commit/2dc9f19c434db2c63c3fdca007143b60ce5548b5) | `9e341564-04a3-4d2e-b3ba-834a9fca1b1d` |
| staging | frontend | [97a7c5a498de](https://github.com/porchday/porchday/commit/97a7c5a498de7a41f1b8460fa41f4041f19cf40b) | `2dc39c39-721e-4117-89cf-9974938f841b` |
| production | api | [1927c4bf3b7f](https://github.com/porchday/porchday/commit/1927c4bf3b7f0277b4b27ffd5689bdbfd8e72dbb) | `08a78a93-14f8-4d37-a66d-725861ad1885` |
| production | frontend | [97a7c5a498de](https://github.com/porchday/porchday/commit/97a7c5a498de7a41f1b8460fa41f4041f19cf40b) | `53cdc97b-fae6-4938-9462-bf017b47fbe3` |

Migration 075 was applied and its function/trigger changes verified in both environments. Existing API runtime differences, deployment topology, notifications and private bindings were preserved. Frontend release assets retain prior immutable modules for open tabs and rollback.

## Verification

- Workspace type checks and 327 web tests passed. API tests cover direct publication without a post, concurrent 10 GB reservations, album access/revocation, and administrator refresh retaining uploader ownership. The preserved-schema suite passed.
- Chromium verified encrypted outbox recovery across reload and an uncertain final response, responsive Share UI, and forward/rollback asset compatibility.
- Staging and production each published a synthetic encrypted standalone video, verified its owner proof and feed entry, compared every decrypted segment with the prepared file, exported authorized chunks, and tested playback and seeking through the deployed service worker. Removing the test connection denied further access. Test accounts and media rows were removed; object deletion was journaled.
- Activation checks preserved an authorized session and continued denying a signed-out session. Hosted login/routes and entrypoint hashes passed. Native push configuration remained enabled.
- Final production monitoring passed 8 samples over 140 seconds with no failed samples. Final audit: `2026-11-07T17:23:33.637Z`.

## Exact-source CI

| Source role | Web/API | iOS simulator | macOS | Secret scan |
| --- | --- | --- | --- | --- |
| frontend | [Passed](https://github.com/porchday/porchday/actions/runs/42393867970) | [Passed](https://github.com/porchday/porchday/actions/runs/42393868010) | [Passed](https://github.com/porchday/porchday/actions/runs/42393868053) | [Passed](https://github.com/porchday/porchday/actions/runs/42393868016) |
| production | [Passed](https://github.com/porchday/porchday/actions/runs/42393886811) | [Passed](https://github.com/porchday/porchday/actions/runs/42393886814) | [Passed](https://github.com/porchday/porchday/actions/runs/42393886808) | [Passed](https://github.com/porchday/porchday/actions/runs/42393886818) |
| staging | [Passed](https://github.com/porchday/porchday/actions/runs/42393889073) | [Passed](https://github.com/porchday/porchday/actions/runs/42393889047) | [Passed](https://github.com/porchday/porchday/actions/runs/42393888941) | [Passed](https://github.com/porchday/porchday/actions/runs/42393888807) |

Current native apps load the shared web UI, so these changes do not require a new signed binary. Internal TestFlight availability remains iOS 247 / macOS 210. The optional Previous app is a migration fallback and does not implement direct segmented-video creation. Physical iPhone Photos-library upload/playback and the original recording remain unverified under #181/#174; automated CI and hosted browser checks do not establish that acceptance.
