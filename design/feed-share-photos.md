# Feed Share Photos and social albums

Status: proposed product design, updated November 2, 2026. This captures the owner's sketch and subsequent interactive mockup decisions. It defines the intended experience, not shipped behavior. [ROADMAP.md](../ROADMAP.md) remains the priority order; issues retain delivery and acceptance evidence.

Porchday separates reading updates, sharing something new, and browsing photos. Photos become independent objects with editable dates. Albums are social spaces with per-person roles, and contribute access to photos without taking away access those photos already had.

## Navigation and visual language

Bottom navigation is **Feed → Share → Albums → Connections → More**. Albums focuses exclusively on photo albums; individual photos are browsed through Feed. More contains Groups, Builder chat, Notifications, Settings and Feature additions, subject to existing authorization. Settings uses a gear rather than the appearance sun icon. Move the post composer out of Feed and into Share.

Feed's icon is a tall post card with a small person inside and the beginning of the next card underneath. It should suggest substantial posts and a stream of content, not a house, generic landscape thumbnail or short list rows. Other navigation icons should have comparable apparent size and line thickness. The mockup uses approximately 40px overall icon height and 1.7px strokes; implementation must account for SVG scaling so enlarging an icon does not make its lines heavier. Preserve readable labels and comfortable touch targets.

Keep Porchday's warm, restrained visual style, wordmark, theme support and clear borders. No “A little of your day.” subtitle on Share. The mockup's sample names, photos, timestamps and counts are illustrative, not product data.

## Feed

Feed displays chronological posts without a composer. Its controls are:

| Control | Choices and behavior |
| --- | --- |
| Content | **Posts / Photos** tabs, visually mirroring Share’s top tabs. Photos filters readable content to photos; it does not change permissions. Replace the earlier content dropdown. |
| View | **Infinite scroll / Calendar**. Infinite scroll replaces the earlier Feed button label; the main navigation destination remains Feed. |
| Author filter | “Show posts by” with independently selectable categories. |

The default author selection is **Me, Friends & Family**: Me, Friends and Family are checked; Extended family and Community are unchecked. The default is an initial selection, not a rule to overwrite a member's deliberate choices on every visit. Persistence and cross-device synchronization remain to be specified.

Checkboxes run **top to bottom, then left to right**. The current order is Me, Family, Friends, Extended family, Community, producing Me / Family / Friends in the first column and Extended family / Community in the second. The later request to swap Friends and Family applies to the Share audience dropdown, not this checkbox list.

Posts retain author identity, time, audience, text, photos/captions, reactions and comments. Filters narrow authorized results; they never grant access. Empty states should explain when no content matches and allow adjusting the filters. Preserve filters and reasonable reading position while changing views.

Calendar months progress with **older months above and newer months below**. Loading earlier months must preserve the visible scroll anchor. Posts retain their server-created chronology; photo dates must not silently redraft post dates or reorder the ordinary post feed.

## Share

Share has two top tabs: **Post / Photos Only**. The bottom navigation tab remains Share; the separate collection destination is Albums.

### Post

Show the author's identity, a substantial text field and selected attachment thumbnails. Directly above the photo area, use the exact heading **“Add Photos to this Post”**. Provide an Add photos action, thumbnail editing/removal, and ordering controls where multiple images are attached.

Keep the audience visible near the final Share post action. Expiration can sit under More options. Do not offer a custom post date.

Include the secondary action **“Skip the post and add photos directly”**. It switches to Photos Only and carries selected photos into that workflow without creating a placeholder post. Preserve the text draft rather than silently discarding it. Implementation must define draft ownership and attachment handling so switching back does not duplicate uploads or publish anything.

### Photos Only

Remove the earlier “Little moments, kept.” heading. Explain briefly that this flow adds photos without creating a post. Let people choose photos, then review a grid. Selecting a thumbnail exposes the photo date, caption and people tags. Dates are editable at upload and afterward. Use the same direct-photo workflow whether reached through the tab, the post shortcut or an album.

The final action clearly says Add photos, or Add photos to album when an album is selected. Selecting files, switching modes or editing metadata never publishes them. Upload failures must retain a recoverable draft and identify what needs attention.

### Standalone sharing audience

The dropdown order is:

1. Friends & family
2. Friends
3. Family
4. Extended family
5. Community
6. Only me

Only me is last. Friends appears before Family. The mockup starts with Friends & family, but whether that is a persistent product default or the member's remembered choice remains a product decision. The destination and effective audience must be apparent before publishing, especially for album uploads.

## Albums and photo browsing

The third navigation destination is **Albums**, focused entirely on social photo albums. Remove the former Grid / Calendar / Albums view switch from this destination. Show album covers, names, photo counts, membership/role information and Create album. Opening an album shows its photos and the relevant contribution and administration controls.

Individual photo browsing lives in **Feed → Photos**, using the same Infinite scroll / Calendar controls and default Me, Friends & Family author selection as Feed → Posts. Feed's Posts / Photos tabs visually mirror Share's Post / Photos Only tabs; retain those distinct labels because browsing and composing are different actions.

Photo calendar placement follows the editable photo date. Posts retain server-created chronology. Both calendar experiences preserve older months above and newer months below. A photo has stable identity independent of attachments and album memberships, so date edits and membership in multiple albums do not duplicate media.

Album discovery is distinct from author filtering in Feed. The Feed author-filter defaults must not hide an authorized album merely because its contributors fall outside the selected categories.

## Social albums

Albums are collaborative from the start. An album-admin can add people and assign each one a role:

| Role | Proposed capabilities |
| --- | --- |
| Read-only | View the album and its photos. |
| Add | View and contribute photos. |
| Album-admin | Manage album details, membership, member roles and which photos belong in the album. |

The creator initially becomes an album-admin. The proposed editing boundary is that contributors edit their own photos; album-admins may remove another person's photo from the album without deleting its original object. Role names and social membership are owner decisions; detailed edit/delete/ownership rules need implementation review.

An album shows an Add photos button for Add and Album-admin members. It opens **Share → Photos Only** with the destination album preselected. The Share screen identifies the album and inherited audience before confirmation; after success, return to the album. Read-only members do not receive a working contribution action. Authorization must be enforced by the service as well as the UI.

People & permissions shows the member list and role selector for each person. Only authorized album-admins can change it. Non-admin contributors still see enough audience information to make an informed sharing decision.

### Permissions inherit without removing prior access

A photo's effective access is the union of its own grants and grants contributed by every album it belongs to, subject to existing block, deletion, expiry and other security restrictions. Album roles determine who can view or manage that album; album membership adds a path to read its photos.

Example: a photo already shared with Friends & family is added to an album containing an otherwise-unconnected reader. Existing friends/family retain access, and the album reader gains access through the album. Adding it to a narrower album must not replace its existing grants. If it belongs to two albums, either album can independently supply access.

Removing a photo from an album, removing a member or deleting an album removes only the corresponding album access path. A remaining direct grant or another album membership can still permit access. Revocation cannot recall plaintext or keys already downloaded. The product should explain retained access instead of promising that album removal makes a previously shared photo private.

Adding existing photos can broaden their audience. Show that change before confirmation. The exact authority required to add someone else's photo to a new album must be settled before implementing redistribution; an Add role alone must not be assumed to authorize resharing every photo a member can read.

Encrypted audience enforcement must support these semantics. Track access provenance so removing one grant does not destroy another. Never obtain the union by making plaintext public or weakening existing authorization. Concurrent role changes, upload retries and album removal must not leave unintended grants.

## Connection circles and mentions

Community means friends/family of friends/family; Extended family means family of family. For both concepts, a family edge exists only when both people label that relationship as family. Extended family requires mutual-family edges on both hops. Use Community for the sketch's “extended friends” wording.

Before generating grants or filtering categories, resolve whether these circles include direct connections, how overlaps are deduplicated, and how relationship changes affect history. Existing consent and restrictive history-sharing choices remain binding. A mention or tag never expands access. Typed mentions in posts, photo captions and comments and opt-in mention push remain separate linked workstreams.

## Open decisions before implementation

- Photo dates: date-only versus timestamp, timezone behavior, missing dates, import metadata defaults, and which date a Feed calendar uses for photo-containing posts.
- Album ownership: last-admin removal, transfer, creator account deletion, album deletion, and retention of contributed originals.
- Contribution rights: adding existing photos owned by others, moving versus copying album membership, reordering, cover selection and who may edit captions/tags.
- Membership changes: invitation/acceptance flow, whether new readers receive all existing album history, blocks within an album, and restricted-history compatibility.
- Interaction: album search/filtering, album comments/reactions versus photo comments/reactions, and read-only contributor prompts.
- Drafts and recovery: cross-tab attachment reuse, interrupted upload recovery, state persistence, export/import and old-client compatibility.

These are unresolved choices, not authorization to invent broader access or silently change existing content.

## Delivery and acceptance

Implement against the existing encrypted photo and history-sharing contracts using backward-compatible changes. Platform parity must be explicit for web/PWA, iOS and macOS; mockup behavior is not evidence of native delivery.

Acceptance should cover:

- Correct navigation order, labels, icon proportions, keyboard access, theme contrast and small-screen layouts.
- Author defaults and column ordering on both Feed content tabs; category changes narrow only authorized results.
- Infinite scroll and calendar transitions, chronological posts and stable scroll anchors when loading older months.
- Post / Photos Only switching, intact drafts, direct uploads without placeholder posts, photo date edits and all entry points.
- Album creation, each member role, permission changes, unauthorized direct requests and the preselected Share destination.
- Grant unions across existing direct access and multiple albums; removing one grant preserves others, while removing the final eligible path denies new reads.
- Concurrent membership changes, lost responses, retries, expiry, blocks, account deletion and cleanup without orphaned accessible media.
- Clear distinction between preview, upload, successful publication and partial failure; real hosted and device evidence before declaring delivery.

## Tracking

| Workstream | Existing issue |
| --- | --- |
| Connection circles and audience definitions | [#122](https://github.com/porchday/porchday/issues/122) |
| Photo identity, dates, direct uploads and social albums | [#123](https://github.com/porchday/porchday/issues/123) |
| Navigation, Feed, Share and Albums presentation | [#124](https://github.com/porchday/porchday/issues/124) |
| Calendar direction and media acceptance | [#108](https://github.com/porchday/porchday/issues/108) |
| Typed mentions and notifications | [#125](https://github.com/porchday/porchday/issues/125), [#7](https://github.com/porchday/porchday/issues/7) |
| Existing history-sharing consent | [#22](https://github.com/porchday/porchday/issues/22) |

This proposal supersedes earlier mockup labels and defaults where they differ: Infinite scroll replaces the local Feed view button, Photos Only replaces Share's Photos subtab, Me joins Friends and Family in default browsing filters, and albums are collaborative rather than personal-only collections. Earlier public-homepage, invitation, deployment and standalone development-tool discussions are outside this design.

November 2 refinement: Albums replaces the Photos navigation destination and has no general photo browser. Feed owns Posts / Photos browsing through top tabs instead of a dropdown. This supersedes the earlier Grid / Calendar / Albums proposal.
