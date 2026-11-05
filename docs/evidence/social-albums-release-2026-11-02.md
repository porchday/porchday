# Feed, Share, Albums and connection circles release

Deployed and verified November 2, 2026 (final audit November 3 at 01:52 UTC). This is web/PWA delivery, not a native app distribution claim. Implementation: [PR #131](https://github.com/porchday/porchday/pull/131). Product contract: [design](../../design/feed-share-photos.md).

## Exact deployed sources

| Component | Staging | Production |
| --- | --- | --- |
| Web asset source | `5b402bff9ccecfbd8a7314755f3537b37b07eced` | `5b402bff9ccecfbd8a7314755f3537b37b07eced` |
| API source | `288f542a0161afa9442012f490956dc2f0cd7566` | `4ff90b27a4fc6581e7d6c826c1f63ffc542d4b70` |
| API version | `c246d126-4fb2-4a6f-92a7-0ae345097b49` | `125b4250-364b-40a1-9ff2-8b70a27bfb9d` |
| Frontend version | `94a00067-82b0-4e91-a390-92bcc7f0dfd2` | `917d6c77-d0c1-4202-84a8-b6e80ff3ad7c` |
| Applied migration count | 68 | 66 |

Environment-specific API commits preserve their existing reliability runtimes. Migrations 060–067 were applied atomically and verified in each environment; production intentionally does not include historical migrations 052/057. The edge runtime remains `86a057c1b3b24f97d307c1d76b63dbe3ed680d10`. Later documentation commits do not change these deployed source pins.

## Delivered behavior

- Feed → Share → Albums → Connections → More; equal navigation icon sizing/strokes and a Settings gear. Feed has Posts/Photos tabs, Infinite scroll/Calendar, column-first filters and Me/Friends/Family defaults. The composer lives in Share.
- Share Post/Photos Only preserves drafts while switching modes, uses the requested captions/audience ordering, and uploads photos without placeholder posts. Album Add photos preselects the destination and returns after successful publication.
- Stable photos have editable date-only calendar dates, owner-signed metadata and bytes, captions/tags, expiration and independent original grants. Post chronology is unchanged. Existing attachments can join albums with source identity/date deduplication and original access preserved.
- Social albums support Read-only/Add/Album-admin, ownership transfer, membership management and history sharing. Only owners add photos to new albums. Admins redistribute existing album photos without forging owner signatures. Album access adds to existing direct/other-album grants; removing the last applicable path denies new reads.
- Community and Extended family derive from the current graph. Extended family requires mutual-family edges throughout. Direct friend history preferences do not restrict either circle's history. New direct connections default to full history with a directional future-only override; stored choices are preserved. Unlocked authorized devices perform encrypted catch-up.
- Web encrypted archives restore owned photos/albums privately, retaining dates, bytes, expiry and attachment associations. Native archive guards direct unsupported collections to web tools rather than silently dropping them.

## Verification

[Final asset-source CI](https://github.com/porchday/porchday/actions/runs/41559968924) and [secret scan](https://github.com/porchday/porchday/actions/runs/41559968929) passed. [Staging API CI](https://github.com/porchday/porchday/actions/runs/41554081206) and [production API CI](https://github.com/porchday/porchday/actions/runs/41554133090) passed. Local validation includes encrypted SQL/HTTP tests for grant unions, role boundaries, revocation, dates, retries, archive/source associations and old/new API compatibility; disposable migration rollback checks; Chromium/WebKit interaction checks; and measured calendar scroll-anchor checks. Native archive guard builds passed separately; no native binary was released here.

Both hosted environments passed final unmodified browser workflows: invitation/login boundaries, consent-only invited policy access, footer/tagline, mobile navigation and filters, Feed/Share behavior, album creation, preselected upload, real encrypted photo decryption, caption/date editing, direct-photo feed appearance and encrypted archive restoration. Hosted role workflows verified Read-only/Add/Admin controls, owner role changes, removal and immediate re-add, and encrypted history redistribution. API and browser checks decrypted both circle histories across future-only direct edges. API checks also verified date edits preserving identity/access, grant removal unions, final-path denial and photo/album export sections.

Final staging frontend activation had 13 continuity samples and zero failures. Production API activation had 20/0; rollback-ready frontend activation 14/0; final frontend activation 12/0. Final protected readiness was healthy, provider versions matched the deployment record, schema fingerprints matched the applied migrations, and public asset bytes matched the pinned source proofs. These bounded checks do not establish a monthly availability percentage.

An earlier staging frontend attempt failed continuity on a five-second authorized-feed deadline and a later profile transport error. The maintained controller rolled back. A subsequent unchanged-deadline baseline passed 20/20, and fresh activation attempts passed. The cause was not established as an application defect; the original failure remains recorded in #3. Diagnostic UI runs are not release acceptance. They found navigation-after-save and stale member-picker defects, fixed in `8a3a7f9` and `5b402bf`; final unmodified workflows passed afterward.

Final cleanup checked all release fixture identities: 41 staging member identities and five invitations; 19 production identities and one invitation. Auth/member/session/account/invitation residual checks passed. No real member content or private keys were inspected. Detailed manifests, synthetic credentials and operational receipts remain private rather than being copied into this document.

The final deployment record's stale schema metadata was reconciled under the shared release lock to the verified 68/66 migration counts and fresh fingerprints. This was a local record correction with zero provider or database writes.

## Remaining verification and separate scope

- #22 remains open for the reported real-member existing-friend wall confirmation after author-side history sharing.
- #108 retains physical-device/installed-client and video acceptance. Hosted browser and local calendar checks do not substitute for those devices.
- #125 typed mentions, #7 notification delivery/badges, #49 TestFlight and #114 Mac App Store/native UI remain separate priorities. This rollout does not claim native album parity.
- Mounted Share-mode draft preservation does not imply durable drafts across navigation/devices. History delivery can remain pending while the required author/admin device is locked or offline. Revocation cannot recall previously downloaded plaintext or keys.
