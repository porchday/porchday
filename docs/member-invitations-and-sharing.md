# Member invitations, sharing and interface verification

The `116c607` application release adds email invitations from existing members, a friends-only posting audience, and a simpler shared interface. Web/PWA and native iOS retain existing controls, encryption, data access and personal profile themes. The latest corn artwork is included from `429906a`.

## Invitations

Connections includes an email invitation form for active members. The API requires an active, verified account and a current session, and honors signup, incident and privacy controls. Each member can make ten requests in a rolling 24 hours; each recipient can receive one new member invitation in seven days. Transactional serialization enforces both limits. Generic responses conceal existing accounts and suppressed duplicates. A successful response confirms an accepted request, not delivery.

An invitation has a single-use, email-bound code and a fragment link. It expires seven days after issue and creates neither an account nor a friendship automatically. The durable encrypted email outbox rechecks eligibility, retries only until the invitation deadline, and prioritizes account/security messages. Sender deletion, expiry, consumption and restore invalidate access as applicable. Account/contact delivery metadata remains service-readable; it is not described as end-to-end encrypted social content.

## Friends-only audience

Post sharing offers Friends & family, Friends only, Family only, and Only me in that order. Friends only excludes connections classified as family. The signed audience, exact recipient set and current relationship authorization apply to posts, photos, comments, replies and reactions. Changing a relationship classification removes historical grants for the classification being left; switching back does not revive them. New eligible connections receive future content unless the author explicitly reshares.

Both clients support the audience, shared JavaScript/Go crypto accepts it, and the archive schema retains its provenance. Imports continue to re-encrypt imported material privately for its destination account. Profile sharing remains Friends & family or Only me.

## Verification

- A disposable PostgreSQL 17 database applied migrations 000–044 from empty. The integrated run passed 381 tests in 67 files plus 15 JavaScript crypto tests, with no database suites skipped. The temporary database container was removed.
- The real-database invitation tests cover session/origin/admission controls, active/verified status, concurrent quota/deduplication, expiry, retry, priority, single-use signup, address binding, deletion, restore and role boundaries. External email delivery is mocked in these local tests.
- Friends-only tests cover encrypted text/photo/comment/reply/reaction authorization, excluded family, stale audience epochs and history after relationship changes. Real-key JavaScript/Go interoperability passed. Eight archive contract tests passed.
- All 78 web tests, typechecks, builds, formatting and secret scans passed after the final wording edits. A private-value comparison covered 448 source/build files with no credential matches.
- Isolated synthetic browser journeys verify invitation acceptance/limit/uncertain-response feedback, pending-submit protection, encrypted friends-only posting, focus, reporting consent and guarded deletion. Desktop and 375-pixel screenshots were inspected without horizontal overflow. This is not a screen-reader audit or a live invitation-delivery test.

Exact-revision Linux CI and native CI passed. Native verification passed 44 unit tests and two UI tests, with two hosted-only tests explicitly skipped. Both hosted databases applied migrations 043/044 and passed installed-function and runtime-permission checks before deployment. Staging and production serve the release with all 19 assets verified; public/protected health is healthy. Fresh synthetic member journeys also passed on both hosted bundles, with every API request intercepted and no live account or email. The original staging fixture import failure is retained separately from the corrected successful runs. Hosted rollout details are recorded in [build status](build-status.md). No independent security review is claimed. Real pilot admission remains gated separately from the owner-authorized staging signup setting.

## Hosted member-invitation request and delivery acceptance

Attempt `4fd78a30` passed on staging at **00:36 UTC October 26** (October 25 Pacific). A normal login by synthetic B requested one invitation to a fresh plus-address in its existing owner-controlled Gmail mailbox. Both the initial and deliberate duplicate requests returned the same generic 202 response. Exactly one durable message existed, and the normal sender recorded provider acceptance after one attempt at 00:36:08.652 UTC. Its invitation expires November 2 at 00:36:07.558 UTC. No invitation token, message body or encrypted payload was read by the verification harness.

The profile, key roster, encrypted backup, relationships and private fixture file were unchanged. The operator session was signed out and its cookie denied; exactly one pre-existing human session remained. Provider acceptance does not prove inbox receipt, link-prefill or successful email-bound signup. Those human-assisted checks remain pending. Private per-step intents, metadata and the final result are retained under `artifacts/private/hosted-smoke/member-invitation-4fd78a30.*`.
