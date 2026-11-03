# Mobile sharing and existing album photos — November 3, 2026

The web/PWA release is active on staging and production. [PR #140](https://github.com/porchday/porchday/pull/140) adds the requested behavior; [PR #141](https://github.com/porchday/porchday/pull/141) fixes a thumbnail overlap caught by staging before production promotion.

## Delivered behavior

- Writable albums offer **Upload new photos** (Share with the album selected) and **Choose existing photos** (paginated multi-select of the member’s own available uploads, including older post attachments).
- Existing album photos are disabled. Partial successes stay added; remaining selections can be retried. Existing audiences, post visibility and expiry are preserved through the existing encrypted sharing functions.
- Feed and Share use **Photos**. Post composition has a divider above **Add Photos to this Post**, followed by small parenthesized text with only **add photos directly** linked. Switching modes preserves the draft.
- Mobile uses a compact corn wordmark header, visually hides redundant outer-tab headings, and places Notifications and Log out under More. Album/detail titles and desktop navigation remain available.

## Verification

- Exact-source CI passed for frontend and both environment-specific API builds, including secret scanning.
- Local API/encryption regression tests: 27 passed. Browser tests cover pagination, disabled existing/unavailable photos, partial-save retry, draft preservation, mobile controls, and widths of 320, 390 and 1200 pixels. The picker regression includes the production theme and actual thumbnail structure.
- Staging and production synthetic acceptance added a standalone past photo and an attachment dated 2014 to an album together. Original readers retained access; album readers decrypted the added photos without gaining access to the source post. Read-only members had no contribution controls. Upload new photos selected the intended album in Share.
- Maintained release-controller activation checked valid/revoked sessions, fresh clients, open tabs and retained assets through both frontend transitions. Synthetic accounts and records were cleaned up; revocation evidence was retained.
- Final provider inventory matched the canonical deployment record, and schema fingerprints were unchanged. No database migration or runtime-flag change was required.

## Active versions

| Environment | API | Frontend |
| --- | --- | --- |
| Staging | `14ea6828-d6f4-453a-b5be-0db13d140055` | `839950d1-763b-483e-a920-9932fc2581a9` |
| Production | `556be238-6639-4043-8ad6-4eff244a33eb` | `9ebcd808-acf7-4dca-930d-f4f7b9f45b19` |

Frontend source: `9fcc6a0e84a3549903cdef80de49705cac1a4c33`. Production API source: `f66c399224c652c57115c6045e15fb348d4bf368`. Staging API source: `a8ef16aee99014877f57c77aaa0c17ea69d96197`.

After frontend activation, the independent production monitor recorded 8 healthy samples over 140 seconds with zero failures. This is a release observation window, not an availability-SLO claim.

Physical-device acceptance remains tracked in [#108](https://github.com/porchday/porchday/issues/108). That issue also records an unrelated themed-calendar scroll-anchor investigation found while expanding browser coverage. This release does not submit a new native binary.
