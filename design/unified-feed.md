# Unified Feed and simple filters

Status: owner-approved design, November 4, 2026. Implementation and production verification are tracked in #124. This supersedes the Feed content tabs and author checkboxes in feed-share-photos.md; Share keeps its Post / Photos creation tabs.

## Experience

Feed opens with posts and directly shared photos together. Keep Infinite scroll / Calendar as view controls. Replace the Posts / Photos tabs and author checkboxes with one expandable filter section. Its collapsed summary reads **Filters · Everything · Friends & Family**. Inside are two labeled native selects:

| Select | Options | Initial value |
| --- | --- | --- |
| Show | Everything, Posts, Photos | Everything |
| From | Only me, Friends, Family, Friends & Family, Extended family, Community | Friends & Family |

Only me shows the signed-in member. Every other option includes their activity alongside the chosen audience. Friends means direct friends; Family means mutually labeled family; Friends & Family includes both. Extended family includes Family and qualifying family-of-family; Community includes direct friends/family and qualifying second-hop connections. These are presentation filters over content the member can already access, never permission grants. Unrelated readable album contributors are not silently added to a relationship selection.

Filters remain selected while switching views during the mounted Feed session. A new Feed session starts with the agreed defaults. Persistent/cross-device preferences are outside this change. Existing photo-specific routes may explicitly initialize Photos.

## Content identity and ordering

- Everything: each readable, non-group post appears once with its existing attachments; independently shared photos also appear.
- Posts: posts, including attached photos.
- Photos: all readable photos, including post attachments, with View post for an attachment.
- An attachment adopted into an album must not duplicate its readable source post in Everything. If the source post is inaccessible, the independently readable photo can still appear without disclosing that post.
- Adding an existing photo to an album does not repost it or change its original sharing timestamp. Moving dates, editing captions and adding grants do not bump activity.
- Infinite scroll orders by sharing/publication time, newest first, with a deterministic ID/kind tie-breaker. Uploading an old photograph therefore appears now, with its photo date displayed separately.
- Calendar places standalone photos on their photo date and posts on publication day in the viewer’s timezone. Everything shows post cards and standalone photo cards in day details; Photos includes attachment photo dates. Keep existing post-only calendar tools available when Show is Posts.

Photo cards show the author, image, caption and photo date. Reuse existing verified decryption, post interaction and photo editing components. Expired/deleted content must disappear; failed loads must not silently present an empty successful feed. Infinite pagination must continue through pages excluded by the From filter. Empty states offer changing filters or going to Share.

## Implementation and compatibility

Extend the authorized photo-feed reader with explicit content and ordering options. Existing callers without these options retain their existing response and date ordering. Build the mixed stream and its cursor in one server query rather than merging independently paginated lists in the browser. Apply row-level authorization, expiry and mute exclusions before returning entries. Deduplication is based on readable source-post identity, not filenames, dates or image hashes. Do not add schema changes or alter encrypted audiences.

Keep original API readers and owned-photo album selection compatible. Deploy the compatible backend first, then the frontend, preserving old/new assets and session continuity. Staging and production acceptance use synthetic identities and encrypted content; no real member data is needed.

## Acceptance

1. Default Feed includes a text post, a post with photos and a directly shared photo, correctly ordered by publication time.
2. A recently shared photograph dated years earlier appears near the top in Infinite scroll and on its photo date in Calendar.
3. Everything does not repeat post attachments or adopted copies; an album-only reader sees an authorized photo without access to its source post.
4. Each content and audience option works, including Only me and self-inclusion for every other option. Friends & Family is distinct and initially selected.
5. Pagination has no duplicate/skipped ties across mixed kinds, remains usable through filtered-out pages and retains authorization/expiry/mute protections.
6. Mobile/desktop layout, accessible select labels, view switching, photo-specific routes, existing album picker, post actions and calendar navigation pass regression checks.
7. Exact-source CI, staged and production browser/API acceptance, retained assets, allowed/revoked sessions, cleanup and post-release monitoring are recorded before closing #124.
