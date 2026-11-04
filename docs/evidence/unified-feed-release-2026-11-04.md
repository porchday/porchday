# Unified Feed release — November 4, 2026

[PR #144](https://github.com/porchday/porchday/pull/144) implements the [approved design](../../design/unified-feed.md). The release is verified on staging and production.

Feed defaults to **Everything** from **Friends & Family**, including the signed-in member. Show and From dropdowns replace content tabs and audience checkboxes. Everything combines posts and standalone photos without repeating attachments whose source post is readable. Photos still includes attachments; Only me is explicit. Infinite scroll uses publication time, while Calendar uses standalone photo dates and post publication days. Share retains Post / Photos creation tabs.

## Verification

- Exact-source push CI passed for the web and both preserved runtime branches. Web CI passed 1,552 tests (one existing skip), plus 27 preserved-schema tests, typechecks, production build, formatting, secret scanning and Chromium calendar/album/unified-feed checks.
- API tests cover precise cursor pagination, mixed-kind ties, source-post deduplication, album-only access, mutes and backwards-compatible query defaults.
- Staging and production synthetic encrypted-content checks passed: every Show/From option, default self inclusion, old photo dates versus publication order, adopted-photo deduplication, album-only source privacy, Calendar, mobile/desktop layouts, existing album selection and Share preselection. Production additionally waited for every visible feed image to decrypt.
- Successful backend and frontend activations passed allowed/revoked session continuity. Baseline/candidate assets remained available for existing tabs and rollback. Root routes and legacy-domain redirects passed.
- Final provider inventory and schema fingerprints matched verified state. No schema changes. Synthetic content, accounts and sessions were cleaned up.

## Deployed versions

| Environment | Backend version | Frontend version |
| --- | --- | --- |
| Staging | `dd09a39a-64e5-4614-81c4-4e01a596fc51` | `faad9e24-bf09-4545-94ee-6ee2ddb2ba04` |
| Production | `be4bea80-9d70-44d7-8298-fbd197337f69` | `6b660ffb-0e1a-4a60-8f1e-47ed34bd818b` |

Web commit: `a62251aa45ddda1e8f63e861d6adcab3e56a5ad8`. Staging backend commit: `4dc80e6ac8f0886b359b836af30d14ce2eb6d69f`. Production backend commit: `77e9f6a6978b921b155d0f99492a3ebe2e2186b8`.

The independent production monitor recorded 8 healthy observations over 140 seconds after frontend activation, with zero failed observations. This is a bounded release observation, not a monthly availability claim.

## Rejected attempts and follow-up

The first staging backend activation had one feed transport failure with no HTTP status; the controller rejected it and automatically rolled back. Sixteen subsequent baseline samples were healthy, the terminal receipt was verified, and owned fixtures were cleaned up before a separately recorded activation passed. The failed attempt is retained as failed evidence.

The first production backend activation stopped in preflight, before deployment intent. It was cancelled through the maintained controller, provider inventory was reconciled against the verified inactive upload, and fixtures were cleaned up before a new activation passed. A later frontend upload completed at the provider but its command did not finish verification; read-only reconciliation verified that exact upload without sending another one. Precise failure diagnostics remain tracked in [#3](https://github.com/porchday/porchday/issues/3).

A staging synthetic browser briefly showed the pre-existing photo-history catch-up warning. Production verification subsequently found no pending photo refresh and successfully decrypted all visible feed images. Further reproduction belongs to [#19](https://github.com/porchday/porchday/issues/19), not an assertion that history sharing is broken or repaired by this release. Native signed-device delivery and media acceptance remain separate work.
