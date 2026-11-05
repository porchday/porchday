# Photo comments and reactions

Owner request, November 4, 2026. Tracking: [#151](https://github.com/porchday/porchday/issues/151). Web/API deployed and verified November 4; see [release evidence](../docs/evidence/photo-interactions-release-2026-11-04.md) for exact source, hosted checks and the separate native distribution/manual-verification status.

Standalone photos have a single encrypted conversation, available from their feed card and every album containing the photo. A small photo icon and “Photo” label distinguish standalone photo entries from posts. The conversation expands below the caption/date; composing a comment does not create a post. Comments are plain text (up to 5,000 characters). The initial reaction selector offers the six familiar post reactions, with one current reaction per person; choosing it again removes it, choosing another replaces it. Nested replies, comment editing, custom reaction images, and notification delivery are outside this first implementation.

The web component and shared iOS/macOS view expose the same controls. A failed save retains the draft and encrypted operation identity for retry. Confirmed saves clear the draft, then refresh the conversation; a refresh failure does not resubmit a confirmed comment. The photo owner can remove comments; other readers can remove their own comments or reaction. Album read-only means no photo contributions or album administration; those readers can still comment and react to photos they can see.

## Access and encryption

Interactions use the existing signed OpenPGP comment/reaction envelopes, with a new `photo` audience and the stable photo ID as `parentId`. The server derives recipients from the union of the photo’s current, already-granted sharing paths, excluding blocks and inactive accounts. It rechecks recipients and directory epoch inside the write transaction. The UI explicitly says the conversation is shared with photo viewers, including album viewers. No interaction grants access to the photo.

Only addressed, currently authorized readers can fetch interactions. Adding an album or connection does not redistribute earlier interactions: their authors’ signed envelopes are left intact. Revocation and expiry cut off further server access; downloaded copies cannot be recalled. A photo’s expiry is inherited exactly. Server-side row policies protect reads and writes, retained author verification keys allow readers in different albums to verify each other, and author handles follow interaction visibility.

Photo deletion cascades to interactions. Removed/replaced interaction IDs enter the existing deletion journal, including restore replay, and cannot be recreated by a delayed retry. Photo interaction ciphertext is not edited in place. Pagination uses server creation time with microsecond precision and a UUID tie-breaker.

## Portability and release

Own contributions are exported through a bounded `photo_interactions` section and written into the existing archive comments/reactions collections with photo parent references. Other members’ conversations are not exported. Deletion invalidates prepared archives. Existing archive import treats these as the member’s private contributions, never as permission to recreate another photo’s conversation.

Validation includes database/API recipient and deletion checks; web/native OpenPGP interoperability; mobile/desktop component checks; native contract tests; exact-source iOS and macOS CI. Hosted/device checks and the existing native parity matrix remain release requirements. Compilation alone does not satisfy them. No production activation is authorized by a passing local test alone.
