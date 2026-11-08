# Recovered-device access and navigation polish

Released November 8, 2026. [PR #189](https://github.com/porchday/porchday/pull/189). Tracks [#22](https://github.com/porchday/porchday/issues/22), [#124](https://github.com/porchday/porchday/issues/124) and [#15](https://github.com/porchday/porchday/issues/15). [Design](../../design/recovered-device-history.md).

New installations that recover usable keys skip redundant copies of their author's posts and photos when only their own new device is missing from the envelope. The server must first confirm that existing peer grants are complete; every attached media envelope must also be readable by the recovered keyset. Missing peer grants, unknown coverage and genuine recipient updates continue through encrypted catch-up. No audience, authorization, connection-history or schema policy changes.

Necessary persistent history updates no longer block navigation between signed-in member pages. Unload, signout and foreground-save protection remain. Progress text describes encrypted access updates rather than reposting. Mobile More destination links are text-only. Desktop omits the redundant More destination and retains direct links, including Builder chat for eligible members.

The native Mac icon has an inset rounded tile and transparent corners. Signed Mac **0.1.0 (255)** is VALID and IN_BETA_TESTING in the existing internal group. The package signature, app and share-extension identifiers, private app-group match, extension network restriction and universal architectures were verified. [Signed build](https://github.com/porchday/porchday/actions/runs/42530869318). Install this binary for the icon change; the shared UI changes load without a new binary in the default native web shells. iOS 247 remains available. This is TestFlight distribution, not public App Store publication.

## Verification

- Workspace typechecks, web regression tests, Chromium/WebKit save-navigation checks, full Chromium calendar/composer checks, real-OpenPGP post/photo API tests and preserved-schema photo tests passed. Missing peer grants remain eligible even when an old envelope still contains their keys.
- Exact-source web, secret-scan, iOS simulator and macOS CI passed for the frontend and each preserved environment-specific API runtime. The maintained production native-parity gate was enforced.
- Hosted staging and production tests created synthetic posts and standalone photos, registered a new trusted device with a valid recovery backup, installed the original and new keys, then observed initial and periodic history checks. No post/photo/media refresh writes occurred, and the original post envelope and photo grant/media remained unchanged.
- The deployed UI retained drafts across member navigation and reload, preserved original photo dates/captions/audience, cleared confirmed publication and explicit discard, showed text-only mobile More links and omitted desktop More. Synthetic accounts/content were removed.
- Authenticated continuity, session revocation, native-shell bridge, canonical routes, asset hashes and old/new open-tab forward/rollback compatibility passed.

The initial staging fixture omitted the backup required for registering a second device and correctly received HTTP 400. It was reconciled and removed; the corrected fixture used the real trusted authorization and complete backup flow. A duplicate PR browser run failed the composer-identity assertion; the exact-source release run and hosted draft checks passed, and the PR rerun passed, including Chromium/WebKit draft recovery.

Physical Mac Dock/switcher acceptance and the original member-specific history scenario remain **needs verification** in #15 and #22. Hosted browser and simulator checks do not claim physical-device acceptance.

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API | `5d327fd0f430787904516a31dc8623abc2943096` | `2427e972-e02e-47f2-9933-ee524b546863` |
| staging | Frontend | `8d89b11adbd65fb713a71edcd9ac6ce23026842c` | `fc75a6e5-8310-4d64-8744-554a5f5a1e88` |
| production | API | `822a4c4d1f650cdfde0051094b2cc73bb0c721dc` | `b34440db-f806-44e1-8298-34f9c7ea5cef` |
| production | Frontend | `8d89b11adbd65fb713a71edcd9ac6ce23026842c` | `3e542291-e644-454e-a5ec-5e3f73ae4257` |

Exact-source verification: [web](https://github.com/porchday/porchday/actions/runs/42530819395), [PR rerun](https://github.com/porchday/porchday/actions/runs/42530891297), [iOS](https://github.com/porchday/porchday/actions/runs/42530819311), [macOS](https://github.com/porchday/porchday/actions/runs/42530819269), [staging API](https://github.com/porchday/porchday/actions/runs/42530854607), [production API](https://github.com/porchday/porchday/actions/runs/42531289806).

Final audit passed at `2026-11-08T22:59:44.281Z`. Production monitoring observed 8 samples over 140020 ms with zero failures. Provider state matched the canonical deployment record, schema fingerprints were unchanged, notification publication remained enabled, and no synthetic fixture rows remained.
