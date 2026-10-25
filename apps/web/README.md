# Porchday web client

React and TypeScript provide the public site and installable PWA. Vite builds static assets served by the Cloudflare application. The API is same-origin at `/api/auth`, `/api/v1`, `/api/account-recovery`, and role-protected `/api/staff`.

## Local work

From the repository root:

```sh
npm run dev -w @porchday/web
npm run build -w @porchday/web
npx vitest run apps/web/test
```

The development proxy expects the local API on port 8787. Use the root development script and isolated test database; never point the local frontend at production account data.

## Routes

| Route                                                     | Purpose                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/`                                                       | Public marketing and illustrated product preview                                                        |
| `/join`, `/login`, `/verify`, `/forgot`, `/reset`         | Invitation registration, verification, password sign-in/reset, MFA challenges                           |
| `/stolen-account`, `/recovery`                            | Stolen-account report, safe-contact confirmation, case resume/evidence/appeals, reviewed restoration    |
| `/app`                                                    | Chronological Home and encrypted composer                                                               |
| `/app/wall/:member?`, `/app/post/:id`                     | Personal wall and a post's conversation                                                                 |
| `/app/connections`, `/app/groups`, `/app/groups/:id`      | Mutual connections and private named groups                                                             |
| `/app/notifications`                                      | Access-checked in-app updates                                                                           |
| `/app/settings/profile`, `/privacy`, `/security`, `/data` | Profile visibility/themes, safety/preferences, account/keys, data controls (each under `/app/settings`) |
| `/app/integrations/authorize`                             | Explicit PKCE integration consent                                                                       |
| `/appeals`                                                | Moderation review, available without decrypting content                                                 |
| `/staff`                                                  | Cloudflare Access and server-role-protected human review                                                |

## Privacy boundaries

Private social content is signed and encrypted through `@porchday/crypto` before upload. Login passwords and the encryption recovery secret serve separate purposes. A dedicated recovery signing identity authorizes fresh device keys; stored backups contain encrypted private-key armor only. Remembering keys on a private browser requires an explicit opt-in. Sign-out clears remembered keys and revokes the browser's push subscription.

The service worker caches application assets only. It never intercepts API requests, stores decrypted posts/photos, or reads push payloads. Push uses a fixed generic notification. Vite versions the shell cache from built assets. A waiting update requires an explicit action and checks for active drafts.

Post/comment audiences come from a fresh server snapshot. Missing recipient keys stop publication. Reactions verify the canonical encrypted tag and count distinct members per emoji. Absolute deadlines hide loaded content when it expires. Reply forms show the inherited deadline and require another review if the server reports a changed deadline.

Ordinary edits do not broaden historical audiences. **Share this memory again** is an explicit author-only copy to a selected current audience. It creates fresh ciphertext, media IDs, and reaction namespace, keeps the original absolute expiry or shortens it, preserves encrypted provenance, and copies no prior comments or reactions. The dedicated server endpoint checks ownership and the reviewed source deadline atomically. Later deletion/shortening of the source does not alter the independent copy; the confirmation explains this.

Profile/group saves deliberately re-encrypt retained pictures for the chosen current recipients. Existing immutable posts are unchanged. A profile can be private to its member or shared with current connections; the exact-lookup handle stays public.

## Data portability

Exports page through owned records, decrypt locally, validate current revisions/deadlines before each download, and write bounded multipart ZIP archives. Default downloads encrypt each ZIP with a separate random archive secret. Readable ZIPs require explicit selection. The final completion part is mandatory; imports require every part, validate paths/expansion limits and photo checksums, and preview the result before writing.

Own imported comments/reactions become private journal entries with context references. Other people's threads are never recreated. Connections and group memberships are reference data; imports never create social relationships. Suspended members retain a read-only vault unlock, owned export, deletion, and appeals. Account deletion remains available from the locked vault even without encryption keys.

## Verification

Frontend tests cover absolute/inherited deadlines, changed-audience messaging, busy-submit locking, timezone display, PWA privacy, archive schema/checksums/HTML escaping/ZIP limits/multipart completeness, and author-only resharing. They supplement server authorization tests and cross-client cryptography tests.

Before opening the pilot, exercise real browser and installed-PWA flows: invitation and email verification; remembering/forgetting keys; two accounts connecting and commenting; nonfriend comments within an authorized thread; image sharing; expiry while a page is open; device recovery and revocation; group moderator removal; exports/imports; account theft recovery and independent staff approval; push permission denial/opt-out; keyboard navigation and small-screen layouts. Browser visual QA and independent accessibility/security review are separate checks, not implied by a successful build.
