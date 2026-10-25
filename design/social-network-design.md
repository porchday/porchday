# Porchday Social Network Design

Status: Implementation reference; pilot admission remains closed  
Updated: October 25, 2026  
Working name: Porchday  
Domain: porchday.com

Porchday is a nonprofit social network for keeping up with people you know. It combines the personal walls and friends feed of early Facebook with the creative profile customization of MySpace. Members can share everyday updates, photos, comments, likes, and emojis without ads, influencer mechanics, or an engagement-ranked feed.

The long-term ambition is a widely used social network in the United States operated for social good. Wikipedia and Mozilla are inspirations for public-interest stewardship, not proposed affiliations. The first release should prove that a small community can maintain meaningful connections on a service whose incentives are aligned with its members.

## Product commitments

| Commitment | Product behavior |
| --- | --- |
| Nonprofit operation | Run by a nonprofit for the public good, with a published mission, governance, and financial reporting. |
| Philanthropic funding | Fund operations through individual donations and philanthropic grants, without selling reach or member data. |
| No ads | No advertising inventory, sponsored posts, paid reach, or behavioral advertising trackers. |
| No algorithm | Show eligible posts chronologically, without engagement-based ranking, personalized recommendations, or paid amplification. |
| No influencers | No followers, creator tiers, monetization programs, trending lists, or popularity-based distribution. Members participate as people in mutual relationships. |
| Up to 300 friends including family | Each member may have at most 300 accepted connections total. Family counts toward the same limit. Enforce this in the database. |
| Friends first | After sign-in, open a chronological feed of eligible posts from accepted friends and family. |
| You control your data | Make it easy to export, integrate with, migrate, or delete your data. |
| Private content stays private | End-to-end encrypt social content so the nonprofit cannot decrypt it; disclose necessary operational metadata and member-submitted reports separately. |
| Web and iOS | Provide an installable PWA and a simple native iOS app using the same account and encrypted content. |
| Open source | Publish the application source under the Apache License 2.0 (`Apache-2.0`), with documentation and a public contribution process. |
| Humans only | No AI agents or automated social accounts. Enforce through community rules, reporting, and moderation at launch; a technical human-verification solution is future work. |
| Personal space | Every member has a customizable profile and their own wall. |
| Control over permanence | Posts and comments can expire automatically; deleting a post removes its comments and reactions. |

“No influencers” describes the network's incentives and permitted behavior, rather than an exclusion based on someone's occupation or off-platform fame. People who have public audiences elsewhere can join under the same rules. Commercial promotion, purchased reach, unsolicited mass invitations, and engagement manipulation are prohibited.

“No algorithm” is the marketing promise of a chronological social feed without engagement-based ranking or recommendation systems. Ordinary software logic still handles ordering, permissions, search, and safety; it does not optimize what members see to maximize time spent.

Family includes chosen family. Mutual confirmation is sufficient; do not collect legal relationship documents. Family is a relationship label for audience controls, not a separate allowance: every accepted connection counts once toward the same 300-person cap.

## Setup authorization and repository

The owner authorized up to $1,000 total spending while setting up the MVP on October 24, 2026. This is a setup spending ceiling, not a monthly budget or a target. Use economical pilot resources, track incurred costs and recurring commitments, and obtain further authorization before exceeding the setup ceiling. An ongoing operating budget remains to be established.

The initial repository is private `bobbyhwilder/porchday` (https://github.com/bobbyhwilder/porchday). Keep it private during development; Apache-2.0 remains the intended license and public source release remains a later launch milestone. Do not advertise source availability before publication. Never commit credentials; the existing secrets file remains outside the repository.

Workers Paid, separate staging/production PlanetScale databases, six restricted Hyperdrive bindings, and private media/recovery-journal/backup buckets are provisioned. The linked PlanetScale organization is `andykonwinski`; both databases have 43 migrations through `042_review_queue_health.sql`. Both deployed applications run `ac3d998`, with verified asset hashes and healthy V3 protected snapshots. The V3 function adds only aggregate moderation/verified-recovery queue age and remains jobs-only; V1/V2 are preserved for rolling deployment.

Cloudflare Email Sending and sender DNS are configured, and the owner confirmed receipt and successful use of three real synthetic signup links. Separate Cloudflare monitors and the hosted restore drill have passed their documented checks.

Updated monitors completed normal post-deployment cron checks at 19:47 UTC with operational status and metrics ready, preserving their secrets and Durable Object state. Sustained auth/recovery-failure alert channels are implemented, but their actual inbox delivery remains unverified. A deployed-source to fresh local-destination archive migration passed its application assertions and independent teardown checks; its runner’s redundant-signout failure remains explicitly recorded in `docs/hosted-archive-migration.md`. Linux CI and hosted iOS simulator builds have passed; this is not evidence that every native interaction or recovery workflow has been verified.

A $10 Cloudflare usage-budget alert is enabled for the account owner; its delivery and exact recent accrued billing remain unverified. The owner confirmed the separate service-monitor attention/recovery email pair. Current deployment versions, test scope, outstanding acceptance and admission gates, and costs are recorded in `docs/build-status.md` and `docs/cost-ledger.md`; provisioning alone does not establish pilot readiness.

## Scope and confirmed decisions

The first release includes email/password sign-in, onboarding, profiles, customization, mutual connections, walls, the home feed, photo posts, comments, reactions, expiration, private named groups, notifications, blocking, reporting, moderation, portable exports/imports, scoped integrations, Apache-2.0-licensed source, and account deletion, delivered through an installable PWA and a simple native iOS app with end-to-end encrypted private content. The repository remains private during this build; public source publication is a separate owner-controlled release milestone.

Confirmed product decisions:

- Use Cloudflare Workers with integrated PlanetScale Postgres through Hyperdrive, private R2 storage, Cloudflare Email Service, and Cloudflare monitoring for the MVP. Supabase and D1 are not part of this architecture. Datadog is deferred until after the MVP.

- Deliver an installable Progressive Web App and a simple native iOS app.
- End-to-end encrypt private social content on member devices. The nonprofit must not possess content decryption keys; operational metadata and explicit reports are separate, disclosed exceptions.

- Members control their data: export, integrations, migration, and deletion are core capabilities, not paid extras. The application will be open source under the Apache License 2.0 (`Apache-2.0`).
- No AI agents may participate as members or operate member accounts. The technical solution for proof of human participation is deferred to future work and is not a launch prerequisite.

- Reactions work like Slack: each member can add multiple distinct emoji reactions to each post or comment. All comments offer the same reaction options as posts.

- Support email/password sign-in only for the MVP. Google and GitHub OAuth are deferred; no social sign-in or email magic-link login is enabled at launch.

- Each member can have up to 300 friends total, including family. There is no separate family allowance.

- Lead the marketing website with “No ads. No influencers. No algorithm.” State prominently that the service is run by a nonprofit for the public good and funded by philanthropy.

- The pilot is adults only, ages 18 and older. Supporting minors requires a separate age, privacy, and safeguarding design before expanding eligibility.
- Members post to their own walls. Friends and family may comment on eligible posts, but cannot create posts on someone else's wall.
- Plan for 10,000 or fewer registered users initially. The operating budget is flexible; select services based on demonstrated reliability, operating effort, and measured costs rather than an assumed fixed monthly ceiling.

Other proposed defaults:

- Start with an invitation-based pilot.
- Include family, friends, and the member's own wall posts in Home. Group posts appear in Groups, with an optional Home filter later.
- Use connections-only wall visibility; offer family-only and only-me audiences per post. No public posts in the first release.
- Make groups private and invitation-only initially.
- Offer optional donations without charging for friend slots, family connections, privacy, or reach.

Direct messages, video, livestreaming, marketplaces, brand pages, public discovery feeds, contact-book imports, native Android apps, and arbitrary profile HTML are outside the first release.

## Member experience

### Visual direction

Use the same simple corn-on-the-cob mark across the website, PWA and native iOS app: a white cutout silhouette in a burnt-orange `#974013` square, without rounding, tilt or gradients. Keep the Porchday wordmark alongside it. The shared assets are deployed in `ac3d998`; desktop/mobile hosted checks confirmed the square logo loaded without horizontal overflow. Native compilation and unit checks passed; its UI checks failed on a stale headline expectation. The test-only correction awaits a new native CI run.

Use the homemade, sometimes clumsy and kitschy personal-page side of early MySpace, rather than a generic social-network portal. The supplied references call for a busy repeating wallpaper behind a narrow centered page, dense unequal columns, square paper panels, contrasting color blocks, chunky/double/dashed borders, small badges, and mixed serif/monospace/sans typography. Use an original burnt-orange, mustard, cream, and dark-brown interpretation; avoid Facebook-like blue identity, corporate navigation bars, oversized editorial heroes, rounded floating cards, and polished dashboard styling. Keep the Porchday hero level, without rotation. Omit the “about this little website” sidebar, the “you are here” bar, and the “friends & family & being yourself” tagline. Use direct, simple language throughout the homepage and footer; the visual style can be personal without cute or diminutive copy. Illustrative profile content must be clearly labeled; no invented live activity, visitor counters, ads, or nonfunctional music controls.

Personal walls retain member-selected colors, fonts, backgrounds, and photos so profiles feel individual. New accounts receive one randomized choice from curated local tiled wallpapers, saved in their encrypted profile; the choice persists across devices and can be changed or removed in settings. Never rerandomize on render or login or overwrite an existing profile’s choice. Tile IDs map to bundled static artwork, never arbitrary CSS, scripts, or external image URLs. Keep text and forms on quiet readable panels, retain visible keyboard focus, semantic headings, responsive stacking, and comfortable touch targets. No flashing, automatic sound, or motion is needed to achieve this style.

### Public homepage

The homepage leads with the commitments **No ads. No influencers. No algorithm.** These must be visible in the opening hero, alongside **Run by a nonprofit for the public good. Funded by philanthropy.** Keep both messages prominent on mobile and desktop rather than relegating them to the footer or an About page.

Proposed hero copy:

- Headline: **a simple social network**
- Core promise: **No ads. No influencers. No algorithm.**
- Mission: **A social network run by a nonprofit for the public good, funded by philanthropy.**
- Supporting copy: **Keep up with friends and family, share everyday moments, and make your profile your own. Your feed shows their posts in chronological order.**

Follow the hero with a preview of a personal wall and a calm chronological feed. Present the supporting value propositions in this order:

1. Explain the three commitments: no advertising, no influencer economy, and no engagement-ranked feed. Explain “no algorithm” in plain language as posts from your people, newest first.
2. Explain nonprofit stewardship and philanthropic funding, with links to governance, financial transparency, and ways to give. Donations support the service without buying visibility or influence over members' feeds.
3. Describe up to 300 friends, including family, under one simple limit.
4. Show profile personalization through colors, backgrounds, and personal details.
5. Feature **You control your data.** Supporting copy: **Export it. Connect your tools. Move to another platform. Or delete it.** Link to concrete instructions and supported formats. Feature **Open source** alongside this promise, with a link to the public code repository and license.
6. Feature **Real people. No AI agents.** Explain the humans-only policy and reporting process; do not claim members have passed technical human verification.
7. Demonstrate photos, comments, reactions, named groups, and optional timers for posts and comments.

Use inline “Join with an invitation” and “About the project” links in the hero, with a separate “Log in” link. In the Account panel, keep “Have an invitation? create account” on one inline text line at ordinary desktop width, with natural wrapping on narrow screens. The sign-in screen offers email/password login and registration, plus a “Forgot password?” link. During a closed pilot, explain invitation eligibility before sending someone through authentication. Include mission, governance, funding, privacy, community rules, accessibility, and contact links. Publish nonprofit status accurately; do not imply tax deductibility or established nonprofit status before these are confirmed.

Use **By invitation only** for the homepage's admission label. Do not show the former “18+ / invitation-only pilot” location bar or “A little closer to your people.” footer tagline. The adults-only pilot and invitation requirements remain enforced and explained in registration and policy screens.

### Progressive Web App and native iOS app

The responsive web application is also an installable Progressive Web App (PWA), with a web app manifest, icons, standalone display, deep links, and a versioned service worker. Cache the application shell and public assets only. The first release requires connectivity to fetch social content; an offline screen explains this and offers retry. Do not persist decrypted posts or photos in service-worker caches. Support installation guidance appropriate to each browser and test updates without losing an in-progress draft or encryption-key access.

Offer opt-in Web Push with generic notifications such as “You have a new update”; neither the push service nor the nonprofit receives plaintext social content. Request permission after a member explicitly enables notifications. On supported iOS versions, Web Push is available to Home Screen web apps; provide clear installation guidance and retain in-app notifications when push is unavailable. [Apple Web Push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)

Build a small native SwiftUI iPhone app with Home, wall/profile, connections, groups, posting/photos, threaded comments, reactions, timers, notifications, and essential security/data controls. Use the same API and encryption protocol as the PWA. Include photo-library selection, optional camera capture, accessible native controls, universal links, and opt-in APNs notifications with generic payloads. Advanced profile theme editing can open the web app; viewing themes and core social actions must work natively. Do not require a separate account or a second social graph.

Use the same email/password authentication service for native iOS, with a library-supported native session flow over HTTPS and revocable device sessions. Keep native session credentials and private-key wrapping material in iOS Keychain; select device-only protection where appropriate and document recovery implications. Database credentials never reach clients. No social OAuth callback configuration is needed for the MVP. [Apple Keychain documentation](https://developer.apple.com/documentation/security/storing-keys-in-the-keychain)

Maintain App Store and TestFlight delivery, signing credentials, privacy disclosures, notification certificates/keys, and a minimum supported iOS version selected during implementation. Test account deletion, lost-device recovery, camera permissions, dynamic type, VoiceOver, and cross-client consistency. PWA and iOS must share protocol test vectors and content formats even if their interface code differs.

### Onboarding and navigation

After email/password registration and email verification, a member confirms they are at least 18, accepts the community rules, chooses a display name and unique handle, optionally adds an avatar, and chooses a profile theme. A short explanation distinguishes friends from family and explains post audiences. Declining adult eligibility prevents pilot enrollment. Age attestation is the proposed pilot mechanism; an authenticated account alone is not proof of age. Do not expose the sign-in email.

Primary navigation: Home, My Wall, Connections, Groups, Notifications, and Settings. On mobile, prioritize Home, Connections, Groups, and My Wall; keep notifications and settings easy to reach. The default post-login destination is Home, while an explicit authorized deep link may return to its original post or group.

An empty Home invites the member to connect with someone and write a first post. It must not fill the space with strangers or suggested viral content. A chronological feed uses explicit “Load more” pagination and a clear caught-up state.

### Connections

A connection is mutual and has one accepted type: friend or family. Requests can be accepted, declined, canceled, or blocked. Pending requests do not count toward the 300-connection limit. Both endpoints must have capacity when any connection is accepted, including family. Each accepted pair consumes one slot for each person.

Changing a connection's friend/family label requires both people's agreement and does not change either person's connection count. Relabeling is allowed at the cap because it creates no new connection. Either person can remove any connection without approval; do not publicly announce removal.

Show a member their own connection usage, such as “184 of 300 friends, including family.” Avoid public connection counts, ranked friends, or a “Top 8.” Make discovery limited to exact handles and invitation links during the pilot. Keep connection lists private by default.

### Walls and Home

A wall contains the owner's posts, newest first, and a profile header with avatar, cover image, bio, interests, and theme. A visitor sees only posts they are currently permitted to read. The owner sees their private posts as well.

Home shows all eligible wall posts from accepted friends and family plus the member's own posts. It does not rank by likes, suppress quiet friends, insert ads, or prioritize donors. Muting a connection hides their posts from Home without removing the connection. Explain active filters and mutes so “all friends' posts” remains understandable.

Order by `(created_at DESC, id DESC)` and paginate with a cursor. An edit does not bump a post. New posts can appear behind a “New posts” button to avoid shifting the page while someone reads. Authorization is evaluated on every page load; a cursor never preserves access after a block or relationship removal.

### Posting and interaction

The composer supports text, emoji, and multiple photos. Proposed initial limits are 5,000 text characters, 10 photos per post, and 20 MB per source photo, subject to cost and upload testing. Provide alt text, image previews, a clear audience selector, and an optional expiration selector before publishing.

Comments support text, emoji, and replies to other comments. Display replies chronologically within their parent thread, with bounded visual indentation for readability. Posts and all comments share the same accessible emoji picker and reaction catalog, including Like (thumbs up), love, laugh, celebrate, and care. Members can add multiple distinct reactions to the same post or comment, as in Slack, but only one of each emoji per target. Selecting an existing reaction adds that emoji for the member; selecting one they have already added removes only their instance of that emoji. Other reactions remain unchanged.

Display reactions as emoji chips with counts of distinct reacting members, highlight the current member's selections, and provide accessible names and selected states. Use stable canonical emoji identifiers consistently across posts and comments. Apply the same behavior to personal-wall and group content. Show reactions in context without using them for ranking or profile popularity scores.

Authors can edit their own text and delete their own content. A wall owner can remove comments on their wall; group moderators can remove group content. A comment audience always inherits its post's audience and cannot broaden it. Notifications link to content and recheck access when opened; email and push previews should omit private or expiring content in the first release.

### Profile personalization

Provide curated themes plus constrained settings for accent colors, background colors or images, cover photos, font choices, and profile section order. Offer About Me, Interests, and a short status. Theme settings live as validated structured data, not executable markup.

Preserve readable contrast, keyboard access, responsive layouts, and reduced-motion preferences. Let visitors switch to a standard readable theme. Do not support custom JavaScript, arbitrary HTML/CSS, tracking pixels, external font URLs, embedded autoplay media, or custom login forms. All uploaded theme assets use the same safe media pipeline as photos.

### Named groups

A group has a name, description, image, owner, moderators, members, and its own chronological wall. Names need not be globally unique; routes use stable IDs or unique slugs. Membership is independent of friendship and never consumes friend slots or grants access to personal walls.

The first release uses private invitation-only groups. Invited people see minimal invitation details; group posts and the member list are visible only to current members. Owners can appoint moderators, remove members, transfer ownership, or delete the group. An owner must transfer ownership or delete the group before leaving.

Group posts support the same photos, comments, reactions, and expiration rules as personal posts. Group moderators cannot override platform safety decisions or extend an author's expiration. A block hides the blocked person's content and prevents interaction even inside a shared group, with a separate audited moderation view limited to content disclosed in reports or already available to a group moderator as a member.

## Privacy and authorization

Default to private social content. Marketing pages are public; member walls, media, groups, and feed APIs require authentication and an explicit authorization decision. Do not index member content in search engines or expose it through public link previews.

| Action | Required permission |
| --- | --- |
| Create a wall post | Authenticated active member posting to their own wall; reject any different wall owner. |
| Read a wall post | Author, or a current connection matching its audience; neither party blocked; post active. |
| Read a group post | Current group membership; applicable block checks; post active. |
| Read a comment or reaction | Access to its parent post and the child item; both active. |
| Comment or react | Permission to read and interact, active account, and open discussion. |
| Edit content | Content author; content still active. |
| Remove content | Author, applicable wall owner/group moderator, or authorized platform moderator. |
| Read media | Access to its owning post or profile asset at request time. |

The author exception does not restore expired content. Blocking takes precedence over connections, family status, discovery, invitations, comments, and notifications. Removing a relationship immediately removes relationship-derived access to historical posts; existing comments may remain for authorized readers until deleted or expired. A new connection sees future eligible posts by default. Historical encrypted posts require an explicit grant from an authorized author device; the server cannot independently add a recipient to old encrypted content. Disclose this behavior when accepting a request.

Account suspension prevents use even if an authentication token remains cryptographically valid. Account deletion removes the member's social content, relationships, memberships, media, and queued notifications, with a documented policy for narrowly retained safety records and backup aging. Exports require renewed authorization and exclude expired or unauthorized third-party content.

## End to end encryption

### Protection and limits

Encrypt content before it leaves the PWA or native app. PlanetScale, Cloudflare, storage providers, backups, and nonprofit staff receive ciphertext rather than plaintext posts, comments, photo originals and thumbnails, captions, alt text, reaction choices, profile details/themes, and private group names/descriptions. Only the sender's authorized devices and intended recipients receive decryption capability. Do not create a staff master key, server-side escrow, or a silent plaintext fallback. TLS and storage encryption are additional protections, not substitutes for end-to-end encryption.

“All data unreadable to the nonprofit” cannot be promised by this architecture. The server needs login identifiers, password hashes for email/password accounts, public handles, device public keys, relationship and group routing records, roles, opaque content IDs, audience permissions, expiry times, ordering timestamps, ciphertext sizes, delivery state, and limited security logs. Protect this metadata in transit and at rest, restrict access, minimize retention, and disclose that the nonprofit can process it. Public marketing content is intentionally public. Reporters may explicitly disclose selected content to moderators. Marketing should say **Your private content is end-to-end encrypted. We cannot decrypt it**, with these exceptions clearly explained.

Encryption does not prevent recipients from copying content, compromised devices from reading it, or a malicious client release from stealing keys. The PWA loads software supplied by the operator; open source alone does not eliminate that trust. Require strict content security policy, no third-party scripts on private app routes, reviewed dependency updates, signed native releases, independently reviewed encryption code, and transparent release practices. Do not claim protection against a malicious operator delivering altered client code until a separately verified client-integrity design supports it.

### Keys and audience changes

Select a maintained, reviewed protocol/library supporting web and iOS, multiple devices, asynchronous recipients, and group membership changes. Evaluate Messaging Layer Security for group key management, while explicitly designing its fit for walls and per-post audiences; it is not a turnkey social-network schema. Do not invent a new cryptographic protocol. Library selection, interoperability tests, and independent review are release gates. [MLS protocol](https://www.rfc-editor.org/info/rfc9420/) and [MLS architecture](https://www.rfc-editor.org/info/rfc9750/)

Each device generates its private keys locally. Upload only public keys and encrypted key material. On the PWA, persist only locally protected key material using reviewed browser cryptography/storage; design browser eviction, sign-out cleanup, shared-device use, and device unlock explicitly. Browser key storage is not equivalent to hardware isolation and does not protect against malicious same-origin scripts. Authenticate device additions through an existing trusted device or a member-held recovery secret, not just a reset login password or support-led account recovery. Provide device lists, revocation, key-change warnings, and recipient key verification; evaluate an auditable key directory to detect server key substitution. Define key epochs, nonce handling, signed authorship, payload versioning, and replay protection in the protocol specification before implementation.

Use authenticated encryption for each content object and independently encrypted media derivatives. Bind object IDs, author, audience/key epoch, parent references, and relevant lifecycle metadata to the authenticated envelope so ciphertext cannot be swapped into another context. Clients verify envelope integrity. Requests to shorten deadlines require signed updates; server access checks still enforce expiry without decryption.

Create encryption audiences matching each post's authorized recipients, including only-me, family, connections, or group members. Replies inherit the parent's eligible audience and must never disclose parent keys to outsiders. Audience changes require authorized clients to update key distribution; do not reuse one permanent key across unrelated audiences. A removed friend, blocked member, departed group member, or revoked device loses server access immediately and is excluded from future key epochs. Already delivered plaintext or keys cannot be recalled. New members receive future content by default; historical sharing is explicit and performed by an authorized client.

For the MVP, explicit historical sharing uses “Share this memory again”: the original author creates a new independent post for a deliberately selected current audience. The client decrypts and re-encrypts only that author's text and photos into fresh object IDs; other members' comments and reactions remain on the original thread and are not copied. Preserve encrypted provenance and the original absolute expiration, allowing a shorter deadline but never restarting the timer. Ordinary edits do not broaden the original audience. The server atomically verifies ownership, current access and expiry when accepting the new copy.

Membership changes while an author is offline must queue any required rekeying without leaking new content under old keys. Present key-setup or rekeying delays instead of silently omitting intended recipients or posting plaintext. Test the 300-connection case and large groups on mobile hardware. Server permissions and cryptographic audiences must agree; a successful RLS check alone cannot grant a decryption key.

### Recovery and expiration

During onboarding, generate a high-entropy recovery secret on the client and help the member store it safely. A backup of account encryption keys may be stored server-side only when encrypted by a recovery key unavailable to the nonprofit. Keep content-recovery keys independent of login passwords and application sessions. Explain that losing all trusted devices and the recovery secret permanently loses access to old encrypted content. Support can restore account access, but cannot decrypt the old content or bypass this limitation.

After a stolen-account recovery, revoke compromised devices, rotate future encryption keys, and use a trusted device or the recovery secret to restore old key access. An attacker who previously copied keys may retain the ability to read previously obtained ciphertext. Restored login access must never grant a new device historical decryption automatically.

Expiry deletes server ciphertext and key envelopes and causes compliant clients to remove local decrypted views and cached content keys. It cannot erase screenshots, exports, or ciphertext and keys already saved by a recipient. Keep the existing inherited-timeout warning and deletion cascade, but describe the guarantee as removal from the service and compliant clients, not cryptographic recall from other people's devices. No offline social-content archive is offered in the first release.

### Feature changes required by encryption

The server builds chronological feeds from routing metadata and returns encrypted objects; clients decrypt and render them. Search within private content is on-device and limited to content the device can currently access. Do not maintain a plaintext server search index. Exact public-handle lookup remains available. Private profile and group previews require the relevant keys.

Process photos on the client: decode safely, strip location metadata, resize, generate thumbnails, and encrypt every variant before upload. The server can validate upload authorization and ciphertext size but cannot inspect an encrypted image's true type or scan its contents. Receiving clients must validate decrypted types and dimensions and use safe bounded decoders even when senders claim processing succeeded. No external thumbnailer, image processor, analytics tool, or moderation service receives undisclosed plaintext.

Store encrypted reaction choices and count/render them on authorized clients. Preserve one instance of each emoji per member/target using an opaque audience-scoped reaction tag derived through the reviewed protocol; the server may observe equality/counts but must not receive the emoji value. The tag construction, malicious-client behavior, and key-rotation handling need protocol review; do not use a public hash of an emoji, which is easy to reverse. API paths use opaque reaction IDs, never plaintext emoji identifiers.

Moderation relies on behavioral metadata and reports. A reporting client previews exactly which selected content and context will be disclosed, then encrypts that report for authorized moderation staff. Staff can decrypt only the disclosed evidence, not browse private walls by role alone. Record the disclosure and retention policy; use an inaccessible-content report path when no readable evidence is available. Group moderators see content through ordinary membership keys or explicit reports.

## Data ownership and portability

### Export and migration

Provide a prominent Data and integrations page in Settings. Export, import, integration management, and account deletion must be easy to find and available without a subscription or support ticket. The member retains control of their contributions; any hosting license should be limited to operating the service and consistent with deletion choices.

Offer a downloadable archive containing versioned JSON, a readable HTML index, and the member's photos in documented standard formats. Include profile and theme settings, authored posts and comments, their reactions, timestamps, original expiry deadlines, audience labels, and a minimal connection/group-membership list. Include alt text and file checksums. Exclude credentials, sessions, recovery tokens, moderation evidence, other members' private contact details, and copies of other people's posts, comments, or photos. References to another person's content may be represented as unavailable context. An export of someone's own comments must not reveal inaccessible parent content.

Generate readable exports on the member's device after decryption, with visible status, cancellation, and retry. Server-side asynchronous jobs may package ciphertext and authorized metadata only; they cannot generate plaintext HTML, JSON content, or media. Offer a locally produced encrypted archive by default and an explicit plaintext export option with a privacy warning. Recheck ownership and expiry during generation and before authenticated download. Any server-held archive contains ciphertext only. Use short-lived private archives, delete them after a disclosed download window, and invalidate or rebuild an archive if included source content expires or is deleted before download. Account deletion invalidates pending exports and stored archives. Warn that downloaded copies are outside the service's deletion control.

Publish the schema, versioning policy, sample archive, and importer interfaces. Provide an importer into another Porchday installation that previews changes, validates checksums and size limits, prevents duplicate imports, and preserves authorship provenance, timestamps, and expiry. Never resurrect expired content, import login secrets, create friendships without consent, or broaden an audience automatically. Imported posts remain private until the member reviews audience mappings. Decrypt and re-encrypt imports on the client for the destination account and audience; do not send plaintext archives to the nonprofit. Restore connections only through fresh mutual acceptance, and respect the 300-connection limit.

Make migration to other platforms practical through standard files and documented adapters. Identify exactly which destinations and fields are supported; no platform can guarantee another service accepts every field. Show unsupported items and offer a complete readable archive instead of silently dropping them. Migration does not imply federation: automatically connecting independent servers is a separate protocol and trust decision.

### Member authorized integrations

Publish a versioned API with documentation, pagination, scoped consent, expiration, revocation, and rate limits. Initial scopes cover ciphertext and routing metadata for the member's own profile, authored content, media, and export status. Decrypted integrations run locally or receive selected data through explicit client-side disclosure; API consent alone does not grant decryption keys. Never hand an integration the account master key. Do not grant access to the friends feed or other members' private content simply because an app can access the member's browser session.

Use authorization-code flows with PKCE for third-party clients and short-lived access tokens with revocable refresh grants. Show the app name, requested data, purpose, and last use in Settings. Revoke grants immediately on request or account deletion. Apply the same ownership, expiry, deletion, suspension, and humans-only policy to API requests as to the web app. Document that revocation stops future access but cannot recall copies already delivered to another service.

Data transport tools may perform member-authorized exports, backups, and migration imports. They must not impersonate a person or autonomously publish posts, comments, reactions, invitations, or moderation decisions. The initial public integration API has no autonomous social-write scopes. Imports use a dedicated reviewed workflow and do not generate new-post notifications or feed promotion. Accessibility tools and direct human-operated clients remain supported. An integration cannot evade the no-agent policy by presenting a member's credentials.

### Open source

Publish the application source in a public repository under the Apache License 2.0 (`Apache-2.0`). Include the license text in a root `LICENSE` file and identify the license in package metadata and the README. Include the frontend, backend, database schema and migrations, build instructions, development setup, tests, and documented Cloudflare and PlanetScale dependencies.

Provide a README, contribution guide, code of conduct, release history, and a private security-reporting channel. Review dependency license compatibility and document ownership of project trademarks separately from the code license. Keep production secrets, member data, private moderation records, and sensitive operational configuration out of the public repository.

The commitment is an inspectable, reusable, and contributable codebase. A supported deployment package for independent operators, alternate hosting infrastructure, and federation are outside the initial scope. Keep the export schema public and preserve portability regardless of the hosting services used by the nonprofit.

### Deletion controls

Offer deletion of individual contributions and the entire account without a support ticket. Before confirmation, show the affected data and offer an optional export; never make export a prerequisite. Require recent authentication, revoke sessions and integration grants immediately on confirmation, stop new social activity, and show deletion progress. Resolve owned groups through transfer or deletion. Apply the existing cascade, media cleanup, backup aging, and minimal retention rules to all paths, including integration copies held by the service and temporary migration archives.

## Humans only policy

### Policy and boundaries

Only humans may hold and operate member accounts. Prohibit AI personas, autonomous agents, bot accounts, and automated posting, commenting, reacting, or connection-building, even when a human created the account. Disclose the rule during signup and provide an agent/bot reporting category. Operational jobs such as email delivery, deletion, and backups are infrastructure, not social participants.

Assistive technology, dictation, translation, and ordinary editing tools do not make an account an agent when a human chooses and submits the action. Whether to restrict human-posted AI-generated media is a separate content-policy decision; the account rule alone does not decide it. Do not use an AI-text detector as proof that a member is a bot.

### Enforcement and appeals

Combine rate limits, behavioral abuse signals, member reports, and moderator review. Suspicion may temporarily restrict social writes while preserving access to settings, data export, deletion, and appeals. A previously trusted account may be compromised; revoke sessions and integration grants during confirmed takeover response. Publish clear reasons for enforcement and an accessible route to human review.

Track confirmed automation incidents, moderation response times, and appeals. Budget for ordinary moderation and appeals; do not require a dedicated human-verification operation for launch. Treat the promise as a humans-only policy supported by evidence and enforcement, not a guarantee that no sophisticated agent can ever evade detection.

## Expiration and deletion

### Member-facing rules

Posts and comments each have an optional `expires_at` timestamp. Suggested choices: never, 1 hour, 24 hours, 7 days, 30 days, or a custom future time. Store timestamps in UTC and show the local date and time with an accessible countdown label.

A comment or reply inherits its parent's effective expiration deadline by default. Its effective expiry is the earliest of its own deadline, every ancestor comment's deadline, and the post's deadline, treating a missing deadline as unbounded. Members can choose a shorter timeout but cannot choose a later deadline or disable an inherited timer. Inheritance uses the same absolute expiration time, not a fresh countdown of the parent's original duration.

Before submission, show a prominent inline warning whenever the post or parent comment has an effective timeout: **This comment will be deleted with the post on {date} at {time} ({time remaining}). You can make its timeout shorter.** For replies, use **This reply will be deleted with the comment on {date} at {time} ({time remaining}). You can make its timeout shorter.** If a reply's parent is itself limited by the post, explain that the deadline is inherited from the original post. Keep the warning next to the composer and expiration control, visible and accessible without opening a menu. Default the control to **Same expiration as parent**, with **Choose a shorter timeout** as the alternative.

For example, replying at 5 p.m. to a comment that expires at 6 p.m. gives the reply at most one hour, even if the parent originally had a 24-hour timer. If the post expires at 5:30 p.m., the reply inherits that earlier deadline. A member can shorten the reply to 5:15 p.m., but cannot extend it beyond 5:30 p.m.

Revalidate the effective deadline on submission. If an ancestor's timer was shortened while the composer was open, update the warning and require the member to review and submit again rather than silently accepting a changed deadline. If the parent expired or was deleted, reject the submission and explain why without publishing an orphan reply. Existing descendants inherit any subsequent shortening immediately.

Before expiry, authors may shorten a timer or add one to permanent content. Once a timer is set, the first release does not allow extending or removing it. This makes a stated disappearance time dependable for participants. Expired content cannot be restored by editing timestamps.

At the deadline, the service denies new access to the post and all comments, reactions, photos, search results, and notification previews; compliant clients remove loaded copies. Recipients may retain copies and keys they obtained earlier. Expiring a comment removes its descendant replies and all their reactions while leaving the parent post and unrelated comment threads intact. Manual deletion follows the same cascade rules.

### Enforcement and cleanup

Read authorization must exclude content with `expires_at <= database_now`, including expired posts and all ancestor comments, even when cleanup jobs are delayed. Every mutation also checks expiry inside its transaction. Clients hide loaded content at its deadline and revalidate when a tab resumes; the server remains authoritative.

Run a scheduled cleanup sweep at least once per minute, processing bounded batches with row locks. In one database transaction, record required media deletions in a durable outbox, remove content-related notification payloads, and hard-delete expired content. Foreign keys use `ON DELETE CASCADE` from posts to comments and reactions, and from parent comments to descendant replies and their reactions. Preserve object paths in the outbox independently of deleted content rows.

A background Worker consumes the outbox and deletes ciphertext originals and all derivatives through its private R2 binding. Deleting PostgreSQL metadata alone does not delete object bytes. Treat an already-missing object as success and retry transient failures with backoff. Monitor the oldest pending deletion and provide a dead-letter recovery process. Keep object keys in the durable outbox until deletion is confirmed. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

Proposed operational targets are immediate denial of new reads at expiry and physical removal from primary database/storage within 15 minutes under normal operation. Alert when cleanup exceeds that window. These are launch targets to validate, not measured guarantees.

Serve private images through an authorized Worker route with `Cache-Control: private, no-store`, including range requests and thumbnails. Avoid public bucket URLs or bearer download URLs that remain valid after a block or expiry. Keep social responses out of shared CDN caches and service-worker offline caches. A download already delivered to someone's device cannot be recalled.

Backups and copies saved by recipients cannot be described as instantly erased. Publish the actual backup retention period once the hosting plan is selected. Maintain a minimal deletion ledger long enough to replay removals after a restore, and do so before reopening access. Any separately retained abuse evidence needs a narrow purpose, access controls, and a disclosed retention schedule; never retain every expired post “just in case.”

## Technical architecture

Use a responsive TypeScript web application on Cloudflare Workers with Static Assets, PlanetScale Postgres for relational data through Cloudflare Hyperdrive, and private Cloudflare R2 buckets for encrypted photos and profile assets. The specific UI framework can be selected during implementation; keep business rules and authorization independent of it. This preserves PostgreSQL while replacing Supabase's database gateway and storage services. D1 is not used.

| Responsibility | MVP service |
| --- | --- |
| Marketing site, PWA, and API | Cloudflare Workers with Static Assets |
| Member authentication | Email/password through a maintained library on Workers; private Postgres identity/session tables |
| Relational data | PlanetScale Postgres connected through Hyperdrive |
| Encrypted photos and derivatives | Private R2 buckets, accessible through authorized Worker routes |
| Expiry and asynchronous work | Cron Triggers, Cloudflare Queues, and a PostgreSQL outbox |
| Transactional email | Cloudflare Email Service |
| Monitoring | Privacy-filtered Cloudflare Analytics Engine metrics, independent scheduled monitor and public status page; PlanetScale database diagnostics. Persisted application request logs/traces remain disabled. |

Create or connect PlanetScale Postgres through Cloudflare's integration and use Cloudflare billing where available. PlanetScale remains the database operator. Consolidated billing does not remove the linked PlanetScale organization or its access requirements: the documented CLI provisioning flow requires PlanetScale credentials as well as Cloudflare billing authorization. Validate the account connection and provisioning route during setup. [Cloudflare PlanetScale integration](https://developers.cloudflare.com/hyperdrive/planetscale/)

Request flow:

1. Browser opens the public marketing site or protected PWA.
2. The authentication service on Workers verifies email/password credentials and creates a revocable application session.
3. Clients encrypt social content; the Worker validates session, account state, request origin, metadata, and ciphertext limits without decrypting it.
4. The Worker connects to PlanetScale Postgres through a Hyperdrive binding using a restricted database role. Social operations use an explicit transaction with the authenticated member's identity set only for that transaction.
5. Application authorization, PostgreSQL row-level security, constraints, and transactional functions enforce access and invariants. The Worker authorizes R2 requests against current database state before reading or writing ciphertext. Clients verify and decrypt authorized content.
6. Scheduled Workers and queue consumers process expiry, media cleanup, and notifications.

Use a supported PostgreSQL driver such as `pg` or Postgres.js with the required Workers compatibility settings. Keep transactions short and do not perform email or object-storage calls while holding database locks. Disable Hyperdrive query caching for all MVP database bindings, including those used by authentication and background jobs: session revocation, blocks, membership changes, and expiry require fresh reads. Hyperdrive does not invalidate cached query results on writes. Connection pooling still works with caching disabled. [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)

Keep the public homepage and authentication routes clearly separate from session-protected application routes. Protect API and media routes as well as HTML. Disable or equivalently secure alternate Worker deployment URLs so they cannot become bypasses. Clients never receive database credentials, a database access token, or unrestricted R2 access. No Supabase JWT exchange, PostgREST endpoint, or Supabase Auth dependency remains.

### Cloudflare hosted member authentication

Email/password is the only MVP member login method. Google and GitHub OAuth and account linking are future work. No social-provider credentials or consent screens are required to launch.

Run authentication on Workers using a maintained library and private identity/session tables in PlanetScale Postgres. Better Auth is implemented and pinned; preserve its tested PostgreSQL/Hyperdrive adapter, Workers compatibility, password hashing, native sessions, email verification and revocation when updating it. Complete the remaining human-assisted recovery acceptance before admission. Reserve Cloudflare Access for staff routes; it does not provide member email/password accounts. [Better Auth basic usage](https://better-auth.com/docs/basic-usage)

For registration, verify email ownership before enabling social actions. Provide login, change-password, forgot-password, email-change verification, and single-use expiring reset links. Store only salted adaptive password hashes using a maintained implementation with parameters tested on Workers. Allow password managers and long passphrases, reject known compromised passwords, and rate-limit login and reset attempts. Use generic responses to reduce account enumeration. Password resets revoke existing sessions and send a security notice. Neither password reset nor support recovery can decrypt old content without a trusted device or the member-held encryption recovery secret.

Require recent authentication for ordinary password and email changes; use the separate verified recovery flow when locked out. Verify a new email before switching it and notify the previous verified address. A supplied or newly verified contact email never merges accounts or proves ownership of another account. Support active-session listing and revocation, offer member MFA, and require strong MFA for staff.

Store opaque application sessions server-side. Web sessions use Secure, HttpOnly, SameSite cookies with CSRF/origin checks and fixed safe redirect destinations. Native sessions use revocable credentials stored in Keychain. Rotate sessions on authentication and sensitive account changes. Check expiration, revocation, member status, and pilot eligibility on every protected request. Logout revokes the application session.

Separate database roles and Hyperdrive bindings for authentication tables, ordinary social operations, and background maintenance; use a distinct migration/owner credential only during deployment. Runtime social credentials must not own tables, have superuser or BYPASSRLS privileges, or grant arbitrary schema changes. Do not expose Postgres directly to members. Store database credentials in Hyperdrive's configuration and application secrets in Workers secret storage, never public assets.

Staff routes additionally use Cloudflare Access with validated issuer, audience, signature, and time claims, plus explicit application staff roles. An Access login alone does not grant moderation privileges. The `/staff` entry and recovery queue must work without a social member account or encryption vault. A read-only identity route exposes only the caller’s verified signed subject, email and current roles; operators assign roles separately. Access loss clears case details and rejects late responses. Only the explicit `/staff/moderation` trusted-device flow can decrypt disclosed evidence. [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

### Stolen account reporting and recovery

Provide an **“My account was stolen”** link on login, password-reset, and Help pages, accessible without signing in. Offer the same action in account security settings for members who still have access. This flow must work when an attacker has changed the email or password, stolen an active session, or compromised the member’s email account. It is a launch requirement and does not depend on future proof-of-human verification.

The report asks for a handle or previous account email, a safe contact address, approximate time of compromise, whether any prior login method remains accessible, and a short description. Never ask for passwords, recovery codes, or provider access tokens in a support form. Verify the safe contact address for case communication; control of that address alone does not establish account ownership. Return a generic acknowledgment and an unguessable case reference without confirming whether an account exists. Rate-limit submissions and restrict case details to the verified claimant channel and authorized support staff.

Support triages reports in a dedicated security queue, with recorded assignment, status, and escalation. Proposed case states are received, awaiting evidence, under review, protected, recovered, and closed. Set a staffed response target and escalation coverage before launch. A report by itself must not reset credentials, transfer ownership, or freeze an account; otherwise false reports become a denial-of-service mechanism. Staff can apply a temporary security hold when corroborating evidence supports suspected compromise.

Verify ownership using previously established login or recovery methods and account security history. Treat recent changes as potentially attacker-controlled. Recovery through an existing secure method can be automated; loss of all trusted methods requires documented manual review and a second authorized reviewer before transferring access. Public profile facts, matching email strings, friend endorsements, or access to a newly supplied address are insufficient on their own. If ownership cannot be established, do not transfer the account; explain the decision through the case channel and provide an appeal. Keep evidence minimal and access audited, with a defined retention period.

A security hold revokes active sessions and integration grants, invalidates outstanding password-reset, recovery, and account-change tokens, and blocks normal account access, new exports, archive downloads, credential changes, social mutations, and destructive actions such as account deletion or group transfer. Pause pending account deletion while ownership is disputed. Preserve a separate limited recovery channel for the claimant. This is an exception to the ordinary policy that social restrictions leave exports and deletion available: suspected takeover must not let an attacker extract or destroy data. Timed posts and comments continue to expire normally; the hold does not extend their retention.

After ownership is established, restore a verified recovery channel, reset compromised password credentials, and rotate application sessions and recovery material. The support case itself does not become a permanent alternative login method. Invalidate old credentials and tokens before issuing a fresh session. Offer MFA setup and let the member review devices, integrations, and recent security events. Notify previously verified contact channels and the verified recovery channel of material security changes without exposing evidence or granting recovery access through an untrusted address. Email and password change notifications include a link to the stolen-account report flow.

Review attacker-created posts, comments, invitations, profile changes, and group actions with the recovered member. Remove or reverse unauthorized changes where safe and supported; do not promise restoration of hard-deleted or expired content, or reversal of copies already downloaded. Keep a minimal audit trail of actions and ownership decisions. Recovery requests and moderation appeals remain accessible while the account is held.

### Data model

| Table | Important fields and constraints |
| --- | --- |
| `members` | UUID, status, created timestamp, notification preferences; separate private contact data. |
| `auth_identities` | Member UUID, unique normalized login email and verification state; library-managed credential identity. No social-provider identities or account linking in the MVP. |
| Private authentication tables | Library-managed credential identities, salted adaptive password hashes, sessions, verification/reset/recovery tokens, and MFA data; never plaintext or reversibly encrypted passwords; inaccessible through member APIs. Store token hashes where supported and enforce expiry and single use. |
| `profiles` | Member UUID, unique public normalized handle, encrypted display name/bio/theme payload and asset references; validate decrypted themes on clients. |
| `connection_requests` | Sender, recipient, requested type, state; no self-requests; one active request per unordered pair. |
| `connections` | Canonically ordered member pair, accepted friend/family type, accepted timestamp; unique pair. |
| `blocks` and `mutes` | Actor and target with unique pairs; block overrides access, mute only filters presentation. |
| `groups` | UUID, opaque route slug, encrypted name/description, owner, privacy, lifecycle state. |
| `group_memberships` | Group, member, role, status; unique group/member. |
| `group_invitations` | Group, inviter, recipient or hashed invite token, deadline, acceptance state. |
| `posts` | UUID, author, wall owner or group ID, encrypted body/envelope, audience, created/edited timestamps, expiry. Exactly one wall/group destination; wall owner must equal author for personal wall posts. |
| `comments` | UUID, post ID, optional parent comment ID, author, encrypted body/envelope, created/edited timestamps, optional own expiry. Parent must belong to the same post; parent links are immutable and acyclic. Effective expiry includes all ancestors. |
| `post_reactions` and `comment_reactions` | Target FK, member, encrypted emoji payload, opaque reaction tag; unique `(target_id, member_id, reaction_tag)` permits multiple distinct emojis but prevents duplicate instances of the same emoji by one member; cascade with target. |
| `media_assets` and `post_media` | Owner, private ciphertext object paths and encrypted derivatives/metadata (including dimensions and alt text), lifecycle status, post association, display order. |
| `notifications` | Recipient, actor, target reference, type, read state; no copied expiring text. |
| `reports` and `moderation_actions` | Reporter, target reference, reason, disposition, limited evidence, audited action and appeal. |
| `account_recovery_cases` | Restricted case ID, claimed account reference, verified safe contact, state, assigned reviewers, minimal evidence references, security-hold decisions, timestamps and retention deadline. No passwords or raw recovery tokens. |
| `device_keys` and `key_envelopes` | Public device keys, authenticated device status, opaque audience epochs and recipient-encrypted content keys; no plaintext private keys. |
| `encrypted_key_backups` | Member, encrypted backup, format/version and recovery metadata; decryption requires a member-held secret. |
| `integration_grants` | Member, client, scopes, expiry, revocation, hashed token references and last use. |
| `data_transfer_jobs` | Member, export/import type, schema version, status, private archive reference, deadline and invalidation state. |
| `deletion_outbox` | Independent object paths, reason, attempts, next retry, completion state. |
| `deletion_ledger` | Minimal identifiers and deletion times for restoration reconciliation; no deleted post bodies. |

Separate post and comment reactions preserve real foreign keys instead of relying on an unchecked polymorphic target. Post-owned photos are not reused by other posts in the first release, so post deletion has unambiguous storage ownership. Profile images have a separate lifecycle.

Index accepted relationships in both endpoint directions, posts by author and creation cursor, group posts by group and cursor, comments by post and creation time, group membership by member, and non-null expiry timestamps. Index notifications by recipient/read state and the outbox by next retry. Measure representative feed queries with members at the 300-connection cap and heavily used groups.

### Transactions and row-level security

Accept connections through a database function that locks both member rows in deterministic UUID order, confirms request and block state, counts each person's accepted connections across both friend and family types, and inserts the accepted pair atomically only if both counts are below 300. All connection acceptance, removal, and type changes must follow the same locking discipline. Revoke direct mutations that bypass it. Two simultaneous acceptances at 299 connections must not produce 301; labeling a request as family cannot bypass the cap.

Authorize every social operation in the Worker and enable PostgreSQL row-level security on member-scoped social tables with default denial. Use a server-derived member UUID in a transaction-local setting, for example parameterized `set_config('app.member_id', memberUuid, true)`, inside the same explicit transaction as the protected queries. Missing or invalid context denies access. Never derive identity from a client-supplied actor ID or leave identity in connection-wide session state: Hyperdrive pools connections by transaction. Policies consult account status, relationships, blocks, group memberships, audiences, and expiry. RLS is defense in depth for trusted server queries, not protection against a compromised Worker credential that can set arbitrary context. Test the actual runtime roles, transaction reuse, rollback, and missing-context paths. R2 has no PostgreSQL RLS; every media route must perform equivalent fresh database authorization. [Hyperdrive connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/)

Social mutations require an active account and the applicable content permissions; there is no human-verification status gate at launch. Export, deletion, and appeals remain available under ordinary social restrictions; a suspected-takeover security hold blocks exports and destructive actions until ownership is resolved, while preserving the recovery and appeal channels. Use narrowly scoped database functions for cross-row invariants. Where elevated functions are necessary, pin their search path, validate the caller internally, and restrict execution grants. Test views and functions for accidental RLS bypass. Every child-content policy checks its parent; filtering only the Home query is insufficient.

Initial API resources include `/me`, `/feed`, `/profiles/:handle`, `/connections/requests`, `/connections/:id`, `/posts`, `/posts/:id/comments`, `/comments/:id/replies`, `/posts/:id/reactions/:reactionId`, `/comments/:id/reactions/:reactionId`, `/groups`, `/groups/:id/members`, `/media`, `/notifications`, `/blocks`, `/reports`, and public `/account-recovery/reports`. Recovery case status and evidence endpoints require a separate scoped recovery session; public submission never grants access to account data. Use idempotent `PUT` and `DELETE` on reaction resources to add or remove the authenticated member's specified opaque reaction ID without changing their other reactions; avoid a toggle API whose retries can reverse the intended action. Use explicit mutation endpoints for acceptance and ownership transfer. Scope upload capabilities to owner, size, type, and expiry. Use idempotency keys for retried creates and request acceptance.

### Media and background work

Process and encrypt photos and derivatives on the sending device as defined in the encryption section. Disable R2 public bucket access, including r2.dev and public custom domains. Upload only ciphertext through authorized Worker routes to private R2 storage, verify ownership, size limits, and complete upload manifests before publishing, and clean up abandoned uploads on a schedule. Clients validate decrypted media before rendering; the server cannot certify image contents.

Keep notifications asynchronous and idempotent; recheck target existence and access before delivery. Start with polling or explicit refresh rather than adding realtime delivery before authorization is proven. Future realtime events must obey the same access rules and trigger revalidation on blocks, membership changes, and expiry.

## Infrastructure and operational readiness

### Environments and deployment

Maintain isolated development, staging, and production environments with separate PlanetScale databases or isolated branches, restricted database roles, Hyperdrive bindings, R2 buckets, Queues, Workers, and application secrets. Use synthetic member data in development and staging. Do not clone production member data into previews. Keep secrets in managed secret storage, never in source control or client bundles. Document setup and credential rotation under organizational ownership.

Use versioned SQL migrations and reproducible Cloudflare configuration. Continuous integration should check types, formatting, critical business logic, RLS isolation, and end-to-end member flows. Require migration review and a tested rollout strategy. Prefer additive schema changes followed by application deployment and later cleanup; an application rollback must remain compatible with the deployed database schema. Preview environments must not connect to production data.

Choose a PlanetScale Postgres region near the initial US community and measure Worker-to-database latency; evaluate Worker placement near the database. Keep database transactions in PostgreSQL rather than spreading them across unrelated requests. Establish custom domains, Cloudflare DNS, TLS, verified email sending, and named organizational owners before launch. Capacity-test the selected database tier and connection pools; keeping PostgreSQL does not establish readiness for 10 million users.

### Accounts and deployment credentials

The MVP requires Cloudflare access with billing enabled, the chosen domain under Cloudflare DNS, and a linked PlanetScale organization/database. Confirm the integrated provisioning flow before assuming a Cloudflare token alone can create or administer the database. CLI provisioning may require a scoped PlanetScale service credential; application runtime uses Hyperdrive database bindings. Keep migration access distinct from runtime access. Do not request an organization-wide administrator credential when a scoped credential suffices.

Record Cloudflare account/zone identifiers, scoped deployment token, application URLs, email sender, Hyperdrive identifiers, and database migration connection details in local/private deployment configuration. Generate authentication secrets and optional Web Push keys during setup. Provider credentials belong in managed secret storage; member content keys are generated on devices and never become deployment secrets. No Supabase, Google OAuth, GitHub OAuth, or Datadog credentials are required for the MVP. Repository hosting access is separate from GitHub login and can be deferred for local development/deployment; publishing the Apache-2.0 source still requires a public repository before claiming open-source availability.

Native iOS development can begin in the simulator without App Store publication. Device distribution, TestFlight, APNs, and App Store release retain their Apple setup requirements and are separate from the web backend's Cloudflare/PlanetScale access.

### Scheduled jobs and queues

Use a Cloudflare scheduled Worker to trigger expiry sweeps, abandoned-upload cleanup, and reconciliation. Use Cloudflare Queues for asynchronous ciphertext cleanup and notification jobs; keep the PostgreSQL outbox as the durable source of pending work. Queue messages carry identifiers, not copies of private post text.

Assume jobs may run more than once and out of order. Give each action an idempotency key, bound batch size and execution time, and provide retry, dead-letter, and manual replay paths. Track leases so crashed workers cannot strand jobs. Reconcile expired content and orphaned media periodically even if an earlier notification or queue delivery failed. Benchmark client-side image processing, encryption, and memory use on supported mobile devices; reduce limits rather than sending plaintext to a server for processing.

### Backup and disaster recovery

Select and verify PlanetScale backup and point-in-time recovery capabilities for the chosen tier. Define a separate recovery plan for R2 objects, including a restricted ciphertext backup copy and its deletion/retention rules; database backups do not include photo bytes. Test recovery of both systems together. Encrypt any exported backups, restrict access, and keep backup lifetimes consistent with the published deletion policy.

Provisional pilot recovery targets are a recovery point within 24 hours and service restoration within 8 hours of a major failure. Revisit these targets for public availability and choose hosting features that actually meet them. Perform a staging restore drill before launch and quarterly thereafter, covering database data, media references, signing configuration, and deletion-ledger replay. Recovery must not restore access to content that expired while the system was offline.

### Monitoring and incident response

Use Cloudflare aggregate metrics, Analytics Engine, service analytics, and a separate scheduled health monitor as the MVP observability platform, supplemented by privacy-reviewed PlanetScale diagnostics. Instrument the API, authentication, jobs, Hyperdrive, R2, and queues. Validate available signals, retention, alert delivery, and database diagnostic privacy during the prototype. Persisted application Workers Logs, invocation logs, traces, and Logpush remain disabled: provider-enriched records can include sensitive request URLs even when the application's own message is sanitized. Do not enable them until synthetic inspection and a reviewed redaction/retention design establish their safety. Datadog integration is deferred and is not an MVP account or credential requirement. [Cloudflare observability](https://developers.cloudflare.com/workers/observability/)

Tag application telemetry with a fixed schema, environment, event/code, normalized route, method, and status class, plus bounded numeric status/duration/count values. Keep release information in deployment records instead of adding unbounded metric dimensions. Do not emit request/trace identifiers. Measure authentication failures, feed latency, API errors, database latency/capacity, storage growth, queue age, deletion lag, notification failures, and aggregate moderation/recovery queue age. Separate development, staging, and production views. Use aggregate time windows and fixed event codes to investigate requests and background work without member identifiers.

Use an allowlist of telemetry fields and redact at the source before emission to Cloudflare or PlanetScale diagnostics. Never send post/comment bodies, decrypted media, profile text, search queries, passwords, cookies, authorization headers, recovery secrets, encryption keys, report evidence, or request/response bodies. Strip URL query strings and replace member/content IDs in paths with route templates. Sanitize errors and stack-trace context; do not collect SQL parameter values. Exclude security-sensitive request data even when a request fails. Keep restricted security audit records separate from general diagnostics and give staff only the access their role requires.

Do not enable session replay, screen recording, DOM capture, or automatic browser/mobile content collection. If PWA or iOS error/performance reporting is added, emit only explicitly reviewed, sanitized operational events; decryption failures contain error codes rather than content or key material. Do not load third-party executable scripts into private app pages. Any bundled client telemetry must pass the same dependency and privacy review as the encryption client, and operational telemetry must never become advertising or member-behavior profiling.

Configure Cloudflare dashboards and supported notifications, plus scheduled health checks for application-specific alerts for service health, latency/error objectives, queue/deletion backlogs, and failed authentication or recovery operations. Use synthetic checks for public availability and core application flows with isolated test accounts and synthetic content; never give monitoring jobs access to real member data or recovery keys. Test monitoring credentials and bot-defense exceptions narrowly so they cannot bypass production authorization. Synthetic test automation is infrastructure, not an allowed automated social participant.

The implemented V3 health check exposes aggregate ages/counts for unresolved retained moderation cases and contact-verified recovery cases, with a provisional 24-hour operator escalation target. It excludes unverified reports and does not promise staffed response times. Sustained authentication/recovery-failure monitoring uses fixed route categories, minimum sample floors and consecutive-window thresholds; idle evidence cannot clear an incident. These channels have isolated regression coverage and an accepted provider query, but no remotely exercised failure/alert-inbox acceptance. See `docs/independent-monitoring.md` for exact thresholds and limitations.

Route actionable alerts to a named operator with a backup. Maintain an independent service-status page and incident runbooks so a monitoring outage does not remove the communication path. Proposed pilot availability is 99.5% per month; revisit staffing and cost before promising a higher target. Telemetry delivery must be asynchronous and bounded: an unavailable telemetry or alert endpoint must not block posting, authentication, or deletion jobs. Monitor dropped telemetry and ingestion failures.

Set explicit metrics retention, sampling, ingestion budgets, and access controls before launch; application log/trace persistence remains off. Keep metric tags bounded; avoid per-member, per-post, or raw-URL cardinality. Account for provider sampling weights when calculating counts and latency, retain useful fixed failure codes within defined budgets, and alert on unexpected ingestion growth. Include Cloudflare telemetry, health-check execution, and PlanetScale diagnostics in operating cost estimates. Review provider retention and data-location controls, disable unsafe SQL capture, and disclose the operational metadata each provider receives. Validate alert capabilities rather than assuming feature parity with Datadog.

Define how to disable uploads, invitations, or posting during an incident while preserving read access where safe. Document procedures for compromised signing keys, exposed secrets, storage failures, lost admin access, abuse surges, and mistaken moderation. Run a security review before opening registration broadly.

### Email and notification infrastructure

Start with in-app social notifications. Transactional email is required for email verification, password resets, stolen-account case communication, and account-security notices. Use Cloudflare Email Service with a domain on Cloudflare DNS and Workers Paid for arbitrary-recipient sending. Email Sending is currently beta: validate account availability, quotas, sender verification, delivery, and bounce/complaint handling before enabling member signup. Configure SPF/DKIM/DMARC and use generic account messages without private social content. Treat failed or unverified delivery as a launch blocker for email-dependent flows, not a reason to bypass verification. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) Separate essential account/security notices from optional social digests. Provide digest preferences, unsubscribe controls for optional mail, and rate limits; do not send an email for every reaction by default.

Account recovery must work for email/password accounts, including when an attacker has changed the login email. Verify recovery channels, notify members of changes, and use the stolen-account process when established methods are lost. Account recovery and encryption-key recovery remain separate. Account deletion removes credentials, sessions, and recovery tokens alongside social data.

### Abuse prevention and resource limits

The 300-connection cap does not bound uploads or request throughput. Apply configurable limits to invitations, posting, comments, searches, group creation, uploads, and total stored media. Use per-account and per-IP signals together, with accessible challenges when needed. Avoid permanent IP-only bans that punish shared households. Let legitimate large families appeal invitation throttles.

Set transparent initial storage allowances after measuring costs; notify members before restricting uploads and never silently delete permanent photos to enforce a quota. Track database compute, backup storage, object storage, media egress, Worker requests, queue operations, image processing, email, authentication compute, staff Access seats, Hyperdrive usage, and Cloudflare telemetry usage. Calculate monthly cost as fixed platform costs plus usage-based services plus moderation and support staffing. Add spending alerts and graceful resource controls before a public launch.

### Accessibility and user controls

Target WCAG 2.2 AA and test keyboard navigation, screen readers, focus management, contrast, image descriptions, zoom, and touch controls. Reaction meanings cannot depend on emoji appearance or color alone. Use reduced-motion preferences and preserve readable typography across themes. Include loading, empty, error, offline, retry, and permission-lost states in interface designs.

Settings must include moderation appeals, connected integrations, migration instructions and an open-source repository link, profile visibility, connection requests, muted members, blocked members, notification preferences, timezone, theme, data export, and account deletion. Clearly explain end-to-end encryption, key recovery, the metadata visible to the service, and optional disclosure of selected content when reporting abuse.

## Safety and nonprofit operations

Nonprofit ownership does not remove the need for moderation. Publish rules against harassment, impersonation, scams, unsolicited commercial promotion, and exploitation. Include accessible reporting, blocking, moderator queues, reasons for enforcement, and appeals in the first release. Give moderators only the access their role requires and audit access to private evidence.

Publish governance, financial reports, moderation transparency, and material product-policy changes. A proposed governance model includes independent board oversight and meaningful member representation. The final legal structure, nonprofit status, adult eligibility enforcement, and retention obligations require organization-specific review before launch.

Fund operations through philanthropy, including individual donations, recurring gifts, and philanthropic grants. Contributions do not buy reach, social status, or control over feed distribution. Explain this funding model on the homepage and publish how funds support the mission. Avoid donor badges in social contexts, sale of member data, and paywalls on privacy controls. Build a budget for hosting, storage, bandwidth, auth seats, moderation, support, accessibility, and incident response. Maintain account export and a shutdown plan so members retain agency if funding ends.

Measure reported connection quality, successful conversations, community safety, accessibility, service reliability, deletion timeliness, and cost per active member. Use aggregate operational metrics with limited retention. Time spent, compulsive return frequency, and ad revenue are not success goals.

## Delivery plan and validation

### Phase 1 Authentication and authorization proof

Implement email/password authentication on Workers with PlanetScale Postgres through Hyperdrive, transactional authorization context, one end-to-end encrypted post, and one encrypted photo in R2 across PWA and iOS. Prototype key setup, recipient verification, device linking, and loss-of-key recovery. Validate email delivery and verification, password changes/resets, stolen-account reporting and holds, logout, revocation, key rotation, RLS denial under runtime roles, pooled-connection isolation, direct-origin protection, and costs. Exit when a second account cannot retrieve the first account’s private content through any API or storage path.

### Phase 2 Core social experience

Build the homepage, onboarding, profiles, themes, requests, family connections, friendship limits, walls, chronological feed, photos, comments, and reactions. Include blocking and basic moderation before inviting members. Exit when a small test community can use the full flow in the PWA and native iOS app, with keyboard and screen-reader access.

### Phase 3 Expiration and groups

Add post/comment timers, read-time expiry checks, cascading deletion, media cleanup and Cloudflare monitoring/alerts, private named groups, roles, invitations, notifications, and account export/deletion. Add the portable archive format, reviewed importer, scoped integration API, and documented open-source release. Exit when cleanup survives outages and retries without leaking expired content or deleting unrelated media.

### Phase 4 Nonprofit pilot

Complete published policies, governance disclosures, support procedures, restore drills, accessibility review, and capacity/cost testing. Run an invitation-based pilot before expanding. Complete an independent encryption review, cross-client interoperability tests, PWA installation tests, and TestFlight validation. General availability depends on adequate operational and moderation staffing as well as feature completion. Data portability, documented integrations, and a published open-source repository must be available before advertising those capabilities.

Required acceptance scenarios:

- Cloudflare monitoring receives useful bounded metrics and failure codes, and delivers actionable alerts without member content or secrets. Automated tests exercise sensitive errors and verify source-side redaction; application log/trace persistence, session replay, and content capture remain disabled.
- A simulated monitoring or alert-delivery outage does not block application requests or cleanup jobs. Alert routing, telemetry-loss detection, retention, sampling, and ingestion-cost controls are verified before launch.

- PWA installation, service-worker upgrades, native iOS login, universal links, and generic push notifications work without leaking content to caches, logs, or push providers.
- Web and iOS exchange encrypted posts, photos, comments, and reactions using shared protocol test vectors. Server database/storage inspection reveals no private plaintext or content decryption keys.
- Revoked devices and removed recipients cannot obtain future content keys; new recipients cannot decrypt historical posts without explicit sharing. Cached copies remain outside the revocation guarantee.
- Account recovery without a trusted device or recovery secret cannot decrypt old content. A report reveals only the evidence the member explicitly chose to share.
- Exports decrypt locally, imports re-encrypt locally, and malicious or oversized decrypted media fail safely on both clients.

- The public source repository includes the Apache License 2.0 text, development instructions, application code, migrations, and contribution/security guidance; release checks detect committed secrets and private data.

- A member exports and imports their profile, photos, and authored content into a clean test environment without losing supported fields, reviving expired content, or exposing other members' private data.
- Revoked integration grants fail immediately; clients cannot read friends' content or perform autonomous social writes. Export archives are invalidated when their included content expires or is deleted.
- Members can report suspected agent accounts; moderators can restrict social actions consistently across the UI and API while preserving export, deletion, and appeals. Launch onboarding requires no technical human-verification step.

- A member cannot post to another member's wall through the interface or direct API calls, but can comment on an eligible post.
- A person who does not confirm they are at least 18 cannot enroll in the pilot.
- A member with 300 accepted connections cannot accept a 301st, whether friend or family. Concurrent acceptances from 299 result in at most 300; acceptance fails if either endpoint is already at the cap.
- Friend/family relabeling requires mutual consent, preserves connection counts, and works at the cap. Removing a connection frees one slot for each person; pending requests consume none.
- Home opens after ordinary login and lists eligible posts chronologically across pagination without popularity ranking or duplicate posts.
- A removed friend, blocked member, or former group member immediately loses the relevant access, including direct image requests and old notification links.
- A post expires while cleanup is disabled: it and all comments, reactions, and media deny new reads immediately.
- A comment expires independently: its descendant replies and their reactions disappear, while its post and unrelated comment threads remain available.
- Comment and reply composers warn about inherited expiration before submission, display the actual date/time and time remaining, and allow only the same deadline or an earlier one. A reply to a comment with an inherited post timeout uses the earliest ancestor deadline.
- If an ancestor deadline changes during composition, submission requires review of the updated warning. Expired or deleted parents reject replies; concurrent creation, deletion, and timer changes cannot leave accessible descendants beyond the ancestor deadline.
- A member can add multiple distinct emojis to a post and to any eligible comment using identical reaction options. Removing one leaves the others intact; concurrent or retried adds of the same emoji count that member only once. Reaction counts and selected states remain correct after reload.
- A post deleted during a concurrent comment/upload transaction cannot leave accessible orphan content or media.
- Storage deletion retries are idempotent; a restore reapplies deletion records before traffic resumes.
- A locked-out member can report a stolen account after their login email or password has changed. An unverified report does not disclose account existence, freeze it, or transfer ownership.
- Corroborated takeover protection revokes sessions and integrations, blocks exports and destructive actions, pauses pending account deletion, and preserves access to recovery and appeals; existing content timers continue to expire.
- Recovery with all trusted methods lost requires two authorized reviewers. Successful recovery invalidates attacker access before restoring the member; unsupported ownership claims can be appealed without bypassing verification.
- Email-verification, password-reset, and account-recovery links expire, cannot be reused, and cannot change another account. Password reset revokes existing sessions without unlocking encrypted history; Google, GitHub, Apple, Microsoft, Facebook, and email magic-link login remain disabled.
- No social-provider login buttons, social OAuth routes, or account-linking flows are enabled in the MVP.
- Email outages, bounced messages, and replayed verification/reset links fail safely without duplicate accounts or unauthorized access.
- Hyperdrive query caching is disabled on every MVP binding; pooled transactions cannot leak member identity. Blocks, revocation, and expiry take effect on the next protected request.
- Direct R2 URLs cannot bypass Worker authorization; object deletion removes ciphertext bytes, with retry and reconciliation after partial failure.
- Tampered, expired, wrong-issuer, or wrong-audience tokens fail; privileged credentials never appear in browser assets.
- Themes remain readable and cannot execute scripts, embed tracking resources, or disguise application controls.
- Group ownership transfer, owner departure, report handling, and member account deletion preserve group integrity.
- A production-like restore recovers the service within its recovery target, preserves deletion decisions, and does not expose private media.
- Queue redelivery, failed image processing, bounced email, and database outages produce recoverable states without duplicate posts or notifications.
- Mobile, keyboard, and screen-reader users can complete signup, connection acceptance, posting, reporting, and account deletion.

Load testing should cover the confirmed initial scale of up to 10,000 registered users, including members at the 300-connection cap with varied friend/family mixes. Use 1,000 daily active members as a provisional workload assumption, not a confirmed forecast; test peak concurrency and media traffic separately. The budget is flexible, but establish operating estimates and spending alerts before launch. Set a provisional p95 feed API target below 500 ms at agreed pilot concurrency, excluding media transfer. Record actual service costs and latency before setting launch commitments.

## Implementation choices and remaining launch decisions

| Decision | Proposed direction |
| --- | --- |
| Encryption protocol and metadata | Select interoperable web/iOS libraries, review audience/key lifecycle and metadata disclosure, and obtain independent security review before launch. |
| Native iOS release | Select the minimum iOS version and finalize App Store, TestFlight, signing, APNs, and platform privacy configuration. |
| MVP monitoring | Validate Cloudflare alerts and PlanetScale diagnostics, select retention and sampling budgets, and assign alert ownership. Datadog is deferred. |
| Product and organization name | Use Porchday as the working product name and porchday.com as the domain; the legal organization name remains to be settled. |
| Cloudflare authentication library | Better Auth email/password is deployed on Workers with PlanetScale/Hyperdrive, with verified session/MFA checks. Reserve Access for staff; finish human email-change/reset and full stolen-account recovery acceptance. |
| PlanetScale provisioning | Staging PS-5 ARM and production PS-20 ARM with two replicas are provisioned in Oregon, billed through Cloudflare, with separate runtime roles, migration access and seven-day backup retention. Both have 43 migrations; actual capacity and accrued billing still need ongoing observation. |
| Definition of family | Include chosen family through mutual confirmation without documentary proof. |
| Content permanence | Default to no timer, with clearly visible optional expiration; shortening only after publishing. |
| Public discovery and groups | Private groups and limited member discovery at launch. |
| Backup and safety retention | Seven-day database/media backups and independent privacy-journal replay are implemented; the real hosted restore passed. Retain the disclosed backup delay and tested first/final deletion obligations when describing erasure. |
| Funding and governance | Establish nonprofit operating structure, member participation, and a realistic annual budget before public launch. |
| Capacity and spending controls | Initial scale is confirmed at 10,000 or fewer users with a flexible budget; validate active usage, peak concurrency, and media traffic, then set spending alerts. |
| Media and recovery budget | Select storage allowances, ciphertext backup features, and tested client-side image processing before launch. |
| Notifications and account recovery | In-app social notifications first; transactional email, tested recovery flows, and a staffed stolen-account response target are required for launch. |
| Open-source release | Publish the application source under Apache License 2.0 with development documentation, and establish contribution and security-reporting processes. |
| Migration destinations | The versioned archive and same-platform importer are implemented; clean-destination application assertions and independent cleanup checks are recorded with the harness failure preserved. Other-product adapters and compatibility remain future validation. |

## Future work

### Additional login providers and Datadog

Google and GitHub OAuth may be added after the email/password MVP, with provider registration, secure native/browser flows, and explicit account linking that never merges accounts merely because emails match. Datadog may be added when operational needs justify a separate observability service; preserve telemetry redaction, cost controls, and nonblocking delivery. Neither is a launch dependency.

### Technical human verification

Design and select a technical solution for proof of human participation after the initial release. No verification provider, live verification interview, biometric collection, verification database table, or verification-based authorization gate is required for launch. Existing authentication, adult eligibility, rate limits, bot-abuse controls, and moderation remain in scope; they must not be advertised as proof of humanity.

Future evaluation should compare spoof resistance, privacy, accessibility, inclusion, cost, false rejections, and operational effort. Define enrollment, rechecks, appeals, retention, and enforcement only after choosing an approach. Avoid mandatory government ID or retained biometrics by default. Login credentials and bot challenges alone do not prove a unique human; any eventual marketing claim must match what the selected system actually establishes.
