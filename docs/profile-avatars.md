# Profile photos throughout Porchday

The same encrypted profile photo identifies a member in the wall header,
navigation, post and comment composers, post and comment authors, connections,
group member lists and notifications that identify an actor. Muted-member rows
also use it; blocked or otherwise inaccessible profiles show a fallback.

Photos use the existing profile and media endpoints and signed envelopes. Seeing
a post, comment, group member or notification does not grant access to that
person's profile photo. Profiles must already have been shared with the viewer's
encryption keys. This change does not broaden sharing or publish headshots.

The web/PWA loader is scoped to the unlocked member and device. Repeated
appearances share one request and object URL; at most four loads run at once.
Visible profiles are rechecked each minute and when the browser regains focus.
Connection changes clear cached photos immediately. Saving a profile refreshes
all its appearances, including a second refresh after new media attachments
become readable. No decrypted avatar is saved to browser storage. The last
appearance unmounting, sign-out, lock or device change releases its object URL.
Expiry, removal and denied reads fall back to an initial. An internal member ID
is never used as an initial.

The native client uses the same authorized profile/media path and memory-only
thumbnails. Its cache is cleared on device changes, lock and profile/connection
changes. Photo expirations are also checked while displaying them.

## Validation

- `npx vitest run apps/web/test/avatar.test.ts` tests request deduplication,
  replacement/removal, stale-result rejection, expiry, concurrency and envelope
  identity checks.
- `node scripts/check-profile-avatars.mjs` runs the real web views in fresh
  Chromium and WebKit browsers with synthetic API/vault boundaries. It covers
  the wall, sidebar, composers, posts, comments, groups, connections,
  notifications, removal/replacement, inaccessible profiles and a mobile layout.
  It does not use real accounts or claim to exercise real encryption.
- `ProfileAvatarTests` covers native cache reuse, invalidation, inaccessible and
  expired photos, and results arriving after a clear. Run it with the simulator
  instructions in [the iOS README](../apps/ios/README.md).

Full native build/simulator validation requires Xcode; a Swift syntax check alone
is not equivalent. Release and remaining device evidence belongs in
[issue #28](https://github.com/porchday/porchday/issues/28).
