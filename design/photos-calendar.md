# Photos calendar, tags and parent-managed children

Desktop owner request, October 31, 2026. Implementation target: web; native binaries require their own release.

## Experience

Mobile Photos replaces My wall in the bottom navigation. A More menu holds My wall, Builder chat (eligible members only), and Settings. Photos opens the current local-calendar month, supports previous/next month, and opens a day's posts. Each day shows a photo when available, otherwise an excerpt. Author and tagged-person filters combine with AND; the tagged-person filter matches tags on the post or any of its photo captions. Empty days remain visible. Each member can choose a post and photo as their personal daily highlight, synced across their devices; unavailable, expired or filtered selections fall back to an eligible item.

Posts, photo captions and comments support explicit person tags chosen from connections and visible parent-managed child profiles. Tags are stored inside encrypted content, never grant access, and do not notify or expose content to someone outside its existing audience. Identity references use stable IDs, not display names. Existing clients retain readable text/captions and ignore additional fields.

Settings allows a parent to create and remove a child profile, name it, record a birthday, and grant/revoke posting permission to current connections. A child is not a login/account. Names are encrypted for the parent's connection circle; birthdays are separately encrypted for the parent's own devices. Posting delegates can post about the child with explicit attribution to the actual adult author. Delegation never grants the parent's account or audience. Other connections can tag a child without being allowed to post on the child's behalf. Removing a connection/blocking invalidates delegation. Previously shared content cannot be recalled from recipients.

## Implementation and acceptance

- Additive schema, RLS and bounded API pagination for month reads, child directory/permissions and personal highlights. Existing post visibility, expiry, blocks and mutes remain authoritative.
- Encrypt tags/names/birthdays on device. Keep plaintext routing metadata minimal and explicitly documented. No child names or birthdays in logs, URLs or analytics.
- Calendar month queries use local month boundaries converted to UTC; explicit pagination, partial-load/error states and bounded decryption concurrency. Do not fetch/decrypt all history.
- New structured payload fields must survive edits/resharing without turning a tag into permission or impersonating a parent.
- Test authorization, blocked/deleted/expired targets, delegate revocation/races, retries, month/timezone boundaries, filtering, selection fallback, old payload compatibility, and mobile keyboard/touch navigation with synthetic data.
- No production rollout until applicable exact-commit CI and staged encrypted journeys, old-client and migration/rollback verification. Keep current application release composition and asset generations intact.

## Open product choice

Default: daily highlight is personal to each viewer. Shared child highlights are a separate behavior pending the owner's answer.

## Local implementation evidence

Implemented on an isolated main-based branch. Calendar and child directory reads are paged; child directory decryption starts when requested rather than adding work to every feed load. Tags can be added/removed in post and comment edits, and photo captions/tags can be edited without uploading the image again. Daily selections sync as private per-member preferences. Child profile updates/deletions and delegate revocation enter the existing privacy journal; replay removes stale records and cannot revive revoked delegates or deleted IDs. Owner archives include encrypted child records and decrypt them only on the owner's device; changes invalidate in-flight exports.

Validation: real PostgreSQL/OpenPGP HTTP and RLS tests cover names/birthdays, adult attribution, idempotent post retries, permission removal, disconnect/reconnect, concurrent revision conflicts, deleted-ID reuse, personal highlights, blocking and restore replay. Chromium uses the real web components and isolated synthetic transport to exercise tags, calendar filters/highlights, child settings and the mobile Photos/More navigation. Transport fixtures do not replace cryptographic database tests.

Release status: not deployed. Hosted CI and staging/production acceptance remain outstanding. Existing native clients can continue old post/comment operations; new child/calendar/tag controls are web-only. An iOS binary is outside this change.
