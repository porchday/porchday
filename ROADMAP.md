# Porchday roadmap

**Current deletion feedback fix:** [#205](https://github.com/porchday/porchday/issues/205), P2: show deletion progress immediately, confirmed completion without waiting for a feed refresh, and a retryable failure state. Implementation under validation; not deployed.

**Current owner follow-up November 9:** [#203](https://github.com/porchday/porchday/issues/203), P2: clickable web links in posted text, preserving punctuation and safe external navigation. Deployed and hosted link activation verified; physical iPhone/macOS external-browser handoff remains follow-up. See [release evidence](docs/evidence/clickable-post-links-release-2026-11-09.md).

**Released November 9:** [#201](https://github.com/porchday/porchday/issues/201) reaction attribution and [#22](https://github.com/porchday/porchday/issues/22) photo-history pending-key/queue fixes are live in production through PR #202. Hosted encrypted sharing and long-press attribution checks passed; non-actionable access banners removed. Physical-device/member-specific acceptance remains `needs verification`. [Release evidence](docs/evidence/reaction-access-release-2026-11-09.md).


**Released November 8:** [#7](https://github.com/porchday/porchday/issues/7) encrypted post/caption/thumbnail notification previews are live in production, with per-device controls. iOS 337 and macOS 320 are available in internal TestFlight. Hosted delivery, access checks and production monitoring passed; physical-device receipt and the earlier crash report remain `needs verification`. [Release evidence](docs/evidence/encrypted-notification-content-release-2026-11-08.md).

**Released November 8:** [#196](https://github.com/porchday/porchday/issues/196), P1, `needs verification`: opt-in device diagnostics and separately consented content recordings are live, including the #198 timeline routing fix. Hosted staging/production checks pass; physical-device and real operator acceptance remain follow-ups. [Release evidence](docs/evidence/diagnostics-release-2026-11-08.md). Deferred Datadog #12 remains deferred.

**Released November 8:** #22 post/photo access updates now recover automatically with per-item backoff and read-back reconciliation, replacing manual Retry buttons. Staging and production synthetic recipient checks pass. [Release evidence](docs/evidence/automatic-access-recovery-release-2026-11-08.md).

**Released November 8:** #7 author/activity notification previews are live; tested notification-tap hardening is available in TestFlight iOS 304 / macOS 267. The reported iOS crash remains P1, `needs verification`: no diagnostic or confirmed root cause yet. [Release evidence](docs/evidence/notification-previews-release-2026-11-08.md).

**Delivered November 8:** #124 makes every Settings tab visible with wrapping rows, separates Notifications and moves Time zone to My profile. Live and verified in staging/production. [Release evidence](docs/evidence/settings-tabs-release-2026-11-08.md).

**Delivered November 8:** [#190](https://github.com/porchday/porchday/issues/190) applies shared UI updates automatically at a safe idle/background point and suppresses routine operational notices. Live in staging/production; encrypted draft preservation and actual automatic reloads verified. [Release evidence](docs/evidence/quiet-updates-release-2026-11-08.md). Native binary installation remains controlled by OS/store settings.

**Delivered November 8:** #22 skips redundant own-device history updates after key recovery and keeps necessary persistent catch-up from blocking member navigation; #124 removes mobile link icons and desktop More; #15 rounds the native Mac Dock/switcher icon. Web/API changes are live and Mac build 255 is available in the existing TestFlight group. [Release evidence](docs/evidence/recovered-device-release-2026-11-08.md) records remaining physical-device/member-specific verification.

**Delivered November 8:** [#187](https://github.com/porchday/porchday/issues/187) preserves Share drafts across navigation and adds encrypted device-local autosave, reload recovery, saved/error feedback and explicit discard. Verified on staging and production, with passing Chromium/WebKit and exact-source iOS/macOS checks. [Release evidence](docs/evidence/post-draft-release-2026-11-08.md).

**Delivered November 8:** [#185](https://github.com/porchday/porchday/issues/185) lets social posts and attachments publish while connections finish encryption setup, with retained future-only eligibility and encrypted author-side catch-up. Verified with four-photo publication, real initial key registration and recipient decryption on staging and production. [Release evidence](docs/evidence/pending-encryption-release-2026-11-08.md).

**Delivered November 8:** [#183](https://github.com/porchday/porchday/issues/183) unifies Add photos/videos, preserves original capture dates, and adds a macOS Photos sharing inbox. Web changes are live; macOS build 236 is available in the existing TestFlight group. [Release evidence](docs/evidence/unified-media-picker-release-2026-11-08.md) distinguishes automated verification from remaining physical picker/share-menu checks.

**Delivered November 7:** [#181](https://github.com/porchday/porchday/issues/181) raises total media storage to 10 GB per person and supports videos without a post, including encrypted retries, albums and portability. [Release evidence](docs/evidence/direct-videos-release-2026-11-07.md) records live staging/production verification and passing exact-source web/iOS/macOS CI. Per-video limits remain unchanged; physical upload/playback acceptance stays in #181.

**Implemented upload fix:** [PR #175](https://github.com/porchday/porchday/pull/175) accepts iPhone recordings with alternate spatial audio tracks while preserving compatible sound and strict prepared-video checks. Rollout evidence and original-recording/device acceptance are tracked in [#174](https://github.com/porchday/porchday/issues/174); HDR handling is unchanged. The follow-up removes trimming, keeps full recordings, and makes optional thumbnail failure non-blocking; #174 also tracks this finalization fix and device acceptance.

**Current owner request:** replace the separate Swift screens with thin iOS/macOS shells around the PWA UI. Track performance and retained-web-view acceptance in [#168](https://github.com/porchday/porchday/issues/168), distribution in #49/#114, and native push in #7. [Design](design/shared-web-native-shell.md). Implemented in [PR #172](https://github.com/porchday/porchday/pull/172); the shared web bridge is live in production. Exact-source iOS/macOS automated checks pass. Signed build availability and remaining physical-device checks are recorded in the linked issues.


Implemented owner follow-up November 6: [PR #169](https://github.com/porchday/porchday/pull/169) addresses repeated native tab reloads and slow navigation with bounded memory caching, request coalescing, stable feed state and background photo decoding. Exact-source iOS/macOS builds and cache regressions pass. [#168](https://github.com/porchday/porchday/issues/168) retains installed-device responsiveness and updated signed app delivery verification.

Delivered November 6: the [signup experience](design/signup-experience.md) improvements under #27 and chronological view label **Feed** under #124 are live in staging and production. [Release evidence](docs/evidence/signup-release-2026-11-06.md) records automated native parity, hosted signup checks and final production verification. #27 retains inbox/device acceptance and the original unconfirmed recipient report. Larger video attachments are also live under #108: 10 minutes, 1 GiB source and 250 MiB prepared, with local quality selection (full-duration uploads; trimming removed by the November 7 owner decision) and resumable encrypted uploads. [Video release evidence](docs/evidence/larger-videos-release-2026-11-06.md) records deployment, automated native parity and remaining device/distribution checks.

The owner’s current product priorities are broader connection circles, first-class photos, simpler navigation, working mentions and notifications, and native app distribution. This is the repository's authoritative order of work. GitHub Issues hold acceptance criteria, implementation status and evidence; this file explains what comes next and why. A merged change to this file changes the default order. It does not authorize deployment, broaden admission or override an issue's approval requirements.

Completed owner follow-up: [#151](https://github.com/porchday/porchday/issues/151) is completed for post-like photo action controls and a clean zoomable photo viewer across web/iOS/macOS. Remove the previously requested Photo badge. Deployed and verified November 4; see [release evidence](docs/evidence/photo-viewer-release-2026-11-04.md). Native source/build tests passed; signed distribution and device checks remain under #49/#114.

Completed feed-header follow-up: [#28](https://github.com/porchday/porchday/issues/28) now uses matching photo/post author headers inside the card. Deployed and verified November 4; see [release evidence](docs/evidence/activity-headers-release-2026-11-04.md). Broader avatar/device acceptance remains open.

Completed owner follow-up: [#161](https://github.com/porchday/porchday/issues/161) lowers the mutual connection cap to 150, including family. Deployed and verified November 4 across normal acceptance, invitation verification, API metadata and web UI; shared native source and CI updated. Existing connections are preserved. See [release evidence](docs/evidence/connection-limit-release-2026-11-04.md).

Last reviewed: **November 4, 2026**. The original November 1 inventory covered 40 open product-backlog issues; the release status below supersedes that snapshot. The owner’s November 1 priority list supersedes the earlier reliability-first planning order; active incidents and release safeguards still take precedence. Priority labels below reflect GitHub labels; #15 is P2. Status summaries are a dated snapshot, so read the linked issue's recent evidence before starting.

Owner follow-up November 3: #123 adds an album picker for any available past upload, including older post attachments, preserving existing audiences. #124 simplifies mobile headers and Share, moves notifications/logout to More, and labels both photo subtabs Photos. **Delivered to staging and production (November 3)**; see [release verification](docs/evidence/mobile-album-picker-release-2026-11-03.md).

Owner follow-up November 4: desktop web navigation should match mobile’s first five destinations, followed by Groups, Notifications, My wall, Feature additions (`</>` icon), Settings. **Delivered to staging and production November 4** under #124; see [release verification](docs/evidence/navigation-order-release-2026-11-04.md). The native Mac sidebar mirrors its native mobile destinations. The merged native parity pass in [PR #150](https://github.com/porchday/porchday/pull/150) replaces the native Photos destination with Albums and adds the unified activity feed. Builder chat stays reachable through More.

Owner release policy follow-up November 4: **bring iOS and macOS implementations to parity before each forward production release**, including backend-only changes, and require exact-source automated native CI. [The parity matrix and release checklist](docs/native-parity.md) separate implemented capabilities from manual acceptance. Per [PR #153](https://github.com/porchday/porchday/pull/153), hosted-native and physical-device checks remain tracked follow-ups and do not block web/API production deployment. Shared native feed/albums/photo-conversation code and exact-source automated checks are complete for the [photo release](docs/evidence/photo-interactions-release-2026-11-04.md); Apple signing/distribution and manual device checks remain #49/#114/#7. Existing durable recovery and rollback remain available.


Owner follow-up November 4: [unified Feed design](design/unified-feed.md) replaces content tabs and author checkboxes with Show/From dropdowns. Default Everything includes directly shared photos alongside posts; Friends & Family includes own activity. **Delivered to staging and production (November 4)** under #124; see [release verification](docs/evidence/unified-feed-release-2026-11-04.md).

Owner bug follow-up November 4: #123 corrects confusing existing-photo picker completion: explicit progress, automatic close after full success, and retained selections after partial failure. **Delivered to staging and production (November 4)**; see [completion-fix verification](docs/evidence/album-picker-completion-2026-11-04.md).

Owner follow-up November 4: **[#151](https://github.com/porchday/porchday/issues/151), P2: standalone photo comments and reactions**, with a photo icon/label in the feed. **Delivered to staging and production (November 4)** with encrypted audience checks, deletion/retry safety and archives. Shared iOS/macOS implementation and automated native verification passed; native distribution/manual acceptance remain separate follow-ups. See [design](design/photo-interactions.md) and [release verification](docs/evidence/photo-interactions-release-2026-11-04.md).

## How to choose the next task

1. An active outage, credible security report or risk of losing access to encrypted content takes precedence. Handle sensitive reports through [SECURITY.md](SECURITY.md).
2. Otherwise, take the highest-ranked **ready next step** in the execution queue. A missing device, recipient response, signing identity or external decision can block that step; record the blocker in its issue and work on the next ready item. Preparation and investigation can proceed before a dependency is resolved; promotion cannot skip its gates.
3. Prioritize completion and verification of existing work over starting another implementation of it. `needs verification` means determine what evidence is missing, not assume either “unbuilt” or “done.”
4. Keep one primary engineering item in progress per implementer. A bounded device/inbox verification task can run alongside it when it does not contend for the same resource. Coordinate all hosted work through the shared release process.
5. Use the [reliability and error-budget policy](docs/reliability.md) to decide whether a release is admissible. A roadmap rank, feature vote or successful smoke test does not waive it.

**P1** means privacy, access, availability or a launch-critical requirement; **P2** means core experience or significant validation; **P3** means lower-urgency polish or exploration. These bands describe urgency, while queue rank selects the next action. An investigation remains an investigation until evidence confirms the cause. Open incident issues do not by themselves mean the service is currently down.

The owner’s explicit order below takes precedence over sorting by label alone; P1 reliability work remains visible in the remaining queue and can preempt on an active incident or release dependency. When proposing changes to that order, compare: current member harm; dependencies unlocked; strength of evidence; and the effort to reach the next verifiable result. Prefer a bounded reproduction or acceptance check over a speculative rewrite. When changing rank, record those reasons and any effort estimate in the issue. Do not invent numerical scores, reach estimates or delivery dates without evidence.

Owner follow-up November 2: retire legacy `.com` website navigation after confirmed member migration; redirect app/login routes to `.org` while preserving API compatibility. Tracked in [#17](https://github.com/porchday/porchday/issues/17).

Owner follow-up: use root-level member routes (`/connections`, `/albums`, `/share`, feed `/`) with compatible `/app/...` redirects; tracked with navigation in [#124](https://github.com/porchday/porchday/issues/124).

Owner follow-up: invitations offer the same full-history (default) or future-only choice as direct connection requests; apply it only to the inviter’s sharing and preserve pending invitations on retries. Tracked in [#99](https://github.com/porchday/porchday/issues/99).

## Execution queue

**Owner notification request (November 6):** unread Feed counts, scroll-to-read, Mark all as read and opt-in Web Push for new feed posts/photos are live. iOS 239 and macOS 198 are available in internal TestFlight. APNs provider configuration is live; device receipt checks remain active under [#7](https://github.com/porchday/porchday/issues/7). [Design](design/feed-notifications.md) · [Release evidence](docs/evidence/feed-notifications-release-2026-11-06.md).

Ranks continue across the sections below. This is an order for selecting work, not a promise to finish every item before taking any lower-ranked verification step.

### Owner top product priorities

**Delivered to production November 2:** Community/Extended family, first-class photos and social albums, and the Feed → Share → Albums → Connections → More web experience (#122–#124). [Release evidence](docs/evidence/social-albums-release-2026-11-02.md) records exact deployed sources, successful staging/production encrypted API and browser acceptance, compatibility and cleanup. The web calendar direction is also delivered; #108 retains device/video verification. #22 retains the reported real-member history check.

Community and Extended family follow the current connection graph, independently of direct-connection history preferences. New direct connections default to full history with a directional future-only override; existing choices remain unchanged. An unlocked authorized device performs encrypted history catch-up.

The [Feed, Share, Photos and social albums design](design/feed-share-photos.md) records the delivered web behavior and platform limits. Native archive compatibility guards are built, but this release does not deliver native album UI parity or a new native binary. Typed mentions (#125), badges/push (#7), and native distribution (#49/#114) remain separate priorities. **Invitation history choice (#99) is the current owner-requested follow-up; typed mentions are next afterward**, subject to active incidents and release safeguards.

These rows follow the owner’s list. The two composer/navigation requests and the gear icon are one UI workstream. “Share” is the second-tab label from the explicit ordered list; “Post” describes its composer. The supplied sketch adds More as tab five, Post / Photos Only tabs inside Share, and Feed content/view/author filters. Use its handwritten numbering for order and the final Albums and Community names from the owner’s text.

| Rank | Issue | Priority | Requested outcome and next step |
| --- | --- | --- | --- |
| 1 | [#122 Community and Extended family](https://github.com/porchday/porchday/issues/122) | P2 | **Delivered (web/PWA, November 2).** Community is friends/family of friends/family; Extended family is family of family. For both, a family edge requires **both sides** to label it family. Verified two-hop eligibility and encrypted audience behavior; include qualifying direct members and share circle history by current graph eligibility independently of per-friend history preferences. |
| 2 | [#123 First-class photos](https://github.com/porchday/porchday/issues/123) | P2 | **Delivered (web/PWA, November 2).** Give photos an editable date at upload and later, and allow direct photo uploads without a post, through Share’s Photos tab or its “add photos directly” link. **Posts cannot have custom dates.** Implemented photo identity, date/calendar semantics and social albums with Read-only / Add / Album-admin roles. Album grants add to existing photo access; preserve attachment compatibility. |
| 3 | [#124 Navigation and sharing UI](https://github.com/porchday/porchday/issues/124) | P2 | **Delivered (web/PWA, updated November 4).** Bottom nav: **Feed → Share → Albums → Connections → More**. Albums focuses on social photo albums; Share has Post / Photos creation tabs. Feed combines posts and standalone photos by default, with Show/From dropdowns, distinct Friends & Family and Only me options, and Infinite scroll / Calendar views. Existing drafts, root links and access boundaries are preserved. [Release verification](docs/evidence/unified-feed-release-2026-11-04.md). |
| 4 | [#125 Typed mentions](https://github.com/porchday/porchday/issues/125) | P2 | Make `@<id>` mentions resolve and render correctly in posts, photo captions and comments, using stable encrypted identity references. Build on existing tags; mentions never expand an audience. |
| 5 | [#7 Feed badges and notifications](https://github.com/porchday/porchday/issues/7) | P1 | **Encrypted text/caption/thumbnail previews live November 8; TestFlight iOS 337 / Mac 320 available with notification extensions.** Reported tap crash remains unconfirmed. Unread Feed counts, scroll-to-read and mark-all; opt-in alerts cover every new eligible feed post/photo. Verify actual Web Push/APNs receipt, background/icon/Dock and permission checks with #49/#114. No physical-device delivery claim yet. |
| 6 | [#108 Calendar scroll direction](https://github.com/porchday/porchday/issues/108) | P2 | **Older months above, newer months below.** Load earlier months upward without moving the visible scroll anchor. Coordinate calendar placement with #123; preserve existing media/filter behavior and finish remaining device acceptance. |
| 7 | [#49 iOS through TestFlight](https://github.com/porchday/porchday/issues/49) | P2 | **Internal TestFlight iOS 337 is processed and available to the existing group.** Verify physical-device installation/recovery, notification behavior and wider tester distribution separately. [Release scope](docs/evidence/encrypted-notification-content-release-2026-11-08.md). |
| 8 | [#114 Desktop through the Mac App Store](https://github.com/porchday/porchday/issues/114) | P2 | **Native Mac 320 is available in internal TestFlight.** Public Mac App Store listing/review and physical Photos/export/Keychain/notification acceptance remain. Internal TestFlight availability does not complete store publication. [Release scope](docs/evidence/encrypted-notification-content-release-2026-11-08.md). |

Design dependencies: #122 must preserve #22’s consent model; #123 informs #108’s calendar placement; #125 supplies eligible mention events for #7. Start Apple access/signing preparation for #49/#114 alongside product work because it can block device verification. Shipping either app does not imply every other priority is already complete; record the build scope explicitly.

### Remaining access and release reliability work

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 9 | [#40 Connection exhaustion and member-route 503s](https://github.com/porchday/porchday/issues/40) | P1 | Availability failures and exhausted connections were observed. Validate current connection headroom through representative traffic and a deployment; establish the remaining mechanism before changing capacity or topology. |
| 10 | [#1 Interrupted privacy operations](https://github.com/porchday/porchday/issues/1) | P1 | **Production activated (November 3).** Journal I/O and request waiting are bounded when fenced writers are enabled. Auth and multi-step operations recover through durable terminal proof; a hosted 210-second delayed-reply drill recovered without persistent quarantine or replaying user work. Reader-first rollout and writer rollback preserve recovery. See #1 for exact release verification and operational limits. |
| 11 | [#55 Logout latency and journey deadlines](https://github.com/porchday/porchday/issues/55) | P1 | Resolve a measured source of failed journeys. Use phase evidence to separate server, pool and network delay; verify old-cookie rejection without merely relaxing deadlines. |
| 12 | [#3 Repeatable release verification](https://github.com/porchday/porchday/issues/3) | P1 | Every change depends on safe delivery. Consolidate remaining private orchestration into the maintained release path, preserve bounded failure diagnostics, and verify recovery/adoption gaps. Existing successful releases are evidence, not a reason to rebuild the controller. |
| 13 | [#2 Signup configuration guard](https://github.com/porchday/porchday/issues/2) | P1 | A small guard prevents recurring loss of invited signup. Compare checked-in deployment configuration with generated approved settings in CI and preflight. Integrate with #3. |
| 14 | [#8 Alert delivery and independent detection](https://github.com/porchday/porchday/issues/8) | P1 | Confirm remaining channels, responder receipt and independent coverage. Track the Mac and GitHub notification destinations under this work; avoid counting them as separate product features. |
| 15 | [#22 Directional history sharing](https://github.com/porchday/porchday/issues/22) | P1 | This is a consent and encrypted-access contract. Reconcile existing implementation/release evidence and finish outstanding hosted/native acceptance, including future-only recipients and revoked access. Do not silently change existing consent. |

### Remaining core pilot work

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 16 | [#27 Invitation signup rejection](https://github.com/porchday/porchday/issues/27) | P2 | A reported signup blocker needs recipient evidence. The intended invitation/destination was identified and valid at inspection; obtain the recipient’s actual submitted destination/error privately and verify actionable guidance. Do not assume premature consumption or replace a valid invitation without cause. |
| 17 | [#88 Background profile setup after recovery](https://github.com/porchday/porchday/issues/88) | P2 | Reproduce through supported account setup to distinguish fixture behavior from a member-facing defect. Confirm the existing write before retrying it. |
| 18 | [#19 Six-member end-to-end acceptance](https://github.com/porchday/porchday/issues/19) | P2 | Establish that social flows work together. Run isolated accounts through connections, audience changes, history sharing, media and deletion; use #22 and #88 findings to explain failures. |
| 19 | [#9 Capacity, mobile performance and cost](https://github.com/porchday/porchday/issues/9) | P2 | Establish a measured pilot envelope rather than extrapolating smoke tests. Start with representative workloads and headroom; coordinate disruptive load with #40 and the release owner. |
| 20 | [#6 Accessibility acceptance](https://github.com/porchday/porchday/issues/6) | P2 | Complete real VoiceOver/NVDA and mobile checks of core flows. File observed defects separately and promote any access-blocking defect on its evidence. |
| 21 | [#24 Photo import compatibility](https://github.com/porchday/porchday/issues/24) | P2 | Decoder compatibility and removal of the source-photo 40 MP cap are deployed; the 50 MiB input limit remains. Verify the original-photo/device cases without weakening encrypted received-media validation. |
| 22 | [#29 Builder chat acceptance](https://github.com/porchday/porchday/issues/29) | P2 | Finish member-facing end-to-end and rollback acceptance of the existing bridge before expanding its scope or allowlist. |
| 23 | [#44 Feature additions and voting](https://github.com/porchday/porchday/issues/44) | P2 | Reconcile delivered board/feed work with hosted acceptance. Verify authorization, concurrent voting and single dispatch before depending on it for further proposals. |
| 24 | [#41 Group invitation visibility and selection](https://github.com/porchday/porchday/issues/41) | P2 | Build on recorded staging acceptance. Reconcile production evidence and finish the remaining owner/non-owner and invitation lifecycle checks. |
| 25 | [#28 Profile photos across the product](https://github.com/porchday/porchday/issues/28) | P2 | Finish remaining surface/device verification, including removal, inaccessible-photo fallback and stale-request cleanup. Reuse implemented behavior rather than duplicating it. |

| 26 | [#200 WebKit reload fetch investigation](https://github.com/porchday/porchday/issues/200) | P2 | Investigate intermittent draft-recovery browser page errors; distinguish canceled reload requests from genuine failures, preserve draft assertions, and verify repeated WebKit runs. User impact is unconfirmed. |

### Remaining polish

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 27 | [#18 Provider-injected analytics](https://github.com/porchday/porchday/issues/18) | P3 | Inspect the provider setting with the required access, suppress injection on exact application hosts, and verify clean browser traffic. Recorded CSP blocking is not evidence of a successful data leak; do not weaken CSP. |
| 28 | [#4 Emoji upload success wording](https://github.com/porchday/porchday/issues/4) | P3 | Make the message location-neutral and verify its accessible announcement and desktop/mobile placement. |
| 29 | [#15 Desktop icon cropping](https://github.com/porchday/porchday/issues/15) | Unset; recommend P3 | Reproduce on the affected desktop installation, adjust padding if needed, and verify the resulting icon rather than inferring from the source artwork. |

## Milestones and standing operational threads

These do not consume additional queue slots for engineering already ranked above. Start external scheduling early when it has a long lead time.

| Issue | Role | Completion or ongoing requirement |
| --- | --- | --- |
| [#42 Demonstrate 99.99% availability](https://github.com/porchday/porchday/issues/42) | P1 reliability milestone | Depends on recovery, capacity, delivery and monitoring work (#1/#40/#55/#3/#8/#9). Require the complete measured window and disclosed coverage in the reliability policy. Keep collecting evidence while engineering proceeds. |
| [#10 Broader launch readiness](https://github.com/porchday/porchday/issues/10) | P1 admission milestone | Independent security review, recovery/moderation coverage, accurate operator disclosures and operating-budget decisions remain distinct gates. Source publication is complete (#16; public visibility and Apache-2.0/contribution/security files verified). Schedule the remaining reviews early. This does not disable the authorized invitation pilot. |
| [#52 Operator Mac alerts](https://github.com/porchday/porchday/issues/52) | P1 standing notification thread | Delivery and receipt acceptance belongs to #8/#42. Keep the destination open while it is in use; its open state is not an outage indicator. |
| [#53 GitHub backup alerts](https://github.com/porchday/porchday/issues/53) | P1 standing notification thread | Verify scheduled coverage, stale-run detection and actual receipt through #8/#42. Keep this destination open while in use. |

## Proposals awaiting decisions

This is the order for design review when capacity is available, not the execution queue. Existing issue-specific approval requirements remain in effect; adding a proposal here does not approve implementation.

| Review order | Issue | Priority | Decision needed before implementation |
| --- | --- | --- | --- |
| 1 | [#94 Standalone collaborative development workspace](https://github.com/porchday/porchday/issues/94) | P3 | Agree the narrow pilot, shared-room visibility, first harness, independent access, credential boundary and usage budget. Publish the reviewed design; keep it separate from routine Porchday delivery. |
| 2 | [#48 One-use surprise delegation tickets](https://github.com/porchday/porchday/issues/48) | P2 | Resolve the policy exception, authorized recipient, scope and one-use enforcement before issuance or redemption. Depends on a verified approval mechanism in #44. |
| 3 | [#47 The Last BBS adventure](https://github.com/porchday/porchday/issues/47) | P2 | Resolve the proposal's recorded approval requirement and scope. It must remain optional and accessible and must not interrupt signup or recovery. #48 is a dependency only if its delegation route is explicitly adopted. |

## Intentionally deferred

These retain their `deferred` labels and are not current release requirements. The order below is a review preference if the owner chooses to reopen scope, not a commitment to start them.

| Review order | Issue | Current priority | Condition for reconsideration |
| --- | --- | --- | --- |
| 1 | [#23 History preferences in exports](https://github.com/porchday/porchday/issues/23) | P2 | Explicitly reopen portable-schema work after the sharing contract is verified. Preserve old archives and never infer new sharing consent from missing fields. |
| 2 | [#20 Federation protocol](https://github.com/porchday/porchday/issues/20) | P2 | Agree the protocol and cross-server trust/revocation model and a bounded interoperability pilot. Existing design work does not make federation a current launch gate. |
| 3 | [#11 Google and GitHub sign-in](https://github.com/porchday/porchday/issues/11) | Unset | Demonstrate demand and approve account-linking/recovery scope after invited email/password access is dependable. |
| 4 | [#12 Datadog integration](https://github.com/porchday/porchday/issues/12) | Unset | Identify a measured monitoring gap, a privacy-preserving signal plan and an approved ingestion budget. #8 must not wait for this vendor choice. |
| 5 | [#13 Technical human verification](https://github.com/porchday/porchday/issues/13) | Unset | Establish the abuse need and acceptable privacy, accessibility, false-positive and appeal tradeoffs before selecting enforcement. |

## November 1 closeout review

Reviewed the 40 open issues against their recorded acceptance and recent evidence, with source checks for likely stale items. No open issue was verified complete in full, so none was closed merely for age or a merged implementation. Completed portions are now distinguished from remaining work in #10 (public source), #24 (photo input limits), #27 (invitation identification), #49 (original simulator tests and Apple registration) and #114 (preview/README and current native direction).

The emoji wording in #4 still exists in `apps/web/src/EmojiPicker.tsx`. #15 still needs installed-icon verification; #18 still needs provider cleanup. #22/#24/#28/#29/#41/#44 retain explicit member, device or hosted acceptance gaps. #3/#8/#9/#40/#55 retain recovery, delivery, monitoring or measurement work; bounded successful releases do not discharge those criteria. Keep #52/#53 open as operational destinations, and preserve deferred features and unapproved proposals.

This was an evidence reconciliation, not a new deployment, device test, or production-data inspection. Historical evidence does not establish current live state. Before closing an item, record its final outstanding acceptance in the linked issue rather than repeating already-completed implementation.

## Keeping this definitive

- Update this file in the same PR as a material change in scope, dependency, priority, deferral or completion. For changes recorded directly in GitHub, reconcile the roadmap in the next repository update before choosing new backlog work. Check it during weekly planning; this is a review practice, not an installed scheduled job.
- Every new open product issue gets one primary row here. Link related issues as dependencies instead of creating competing queue entries for the same work. Put operational notification threads and milestone trackers in their separate section.
- The issue owns detailed status and acceptance evidence. The roadmap owns rank and the next step. If they disagree, reconcile the newer evidence and record the decision; do not silently assume the easier interpretation.
- When changing priority, update the issue label and this file together and leave a short reason in the issue. Distinguish an owner-directed reprioritization from a recommendation still awaiting a decision. Retain `deferred` until scope is explicitly reopened.
- For a blocked item, record the exact missing dependency, the next action and the responsible person when actually assigned. Do not invent owners or dates. Continue independent ready work rather than leaving the whole queue idle.
- Remove completed product issues from the queue only when their acceptance criteria are verified. Put commit, tests and deployment/device evidence in the issue; retain `needs verification` for outstanding checks. Closed issues and [CHANGELOG.md](CHANGELOG.md) hold the history rather than an ever-growing “done” list here.
- A merged PR is not a deployed feature. Track small follow-up PRs on their issue even when the parent work is complete, and give any unfinished delivery step an explicit place in the issue or queue.

Roadmap maintenance is tracked in [#120](https://github.com/porchday/porchday/issues/120). The top eight workstreams reflect the owner’s explicit priorities; the remaining order is the prior planning baseline. Neither is an effort estimate or a waiver of operational safeguards.
