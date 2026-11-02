# Porchday roadmap

The owner’s current product priorities are broader connection circles, first-class photos, simpler navigation, working mentions and notifications, and native app distribution. This is the repository's authoritative order of work. GitHub Issues hold acceptance criteria, implementation status and evidence; this file explains what comes next and why. A merged change to this file changes the default order. It does not authorize deployment, broaden admission or override an issue's approval requirements.

Last reviewed: **November 1, 2026**. Covers the 40 open product-backlog issues at that review. The owner’s November 1 priority list supersedes the earlier reliability-first planning order; active incidents and release safeguards still take precedence. Priority labels below reflect GitHub labels; #15 has no priority label yet. Status summaries are a dated snapshot, so read the linked issue's recent evidence before starting.

## How to choose the next task

1. An active outage, credible security report or risk of losing access to encrypted content takes precedence. Handle sensitive reports through [SECURITY.md](SECURITY.md).
2. Otherwise, take the highest-ranked **ready next step** in the execution queue. A missing device, recipient response, signing identity or external decision can block that step; record the blocker in its issue and work on the next ready item. Preparation and investigation can proceed before a dependency is resolved; promotion cannot skip its gates.
3. Prioritize completion and verification of existing work over starting another implementation of it. `needs verification` means determine what evidence is missing, not assume either “unbuilt” or “done.”
4. Keep one primary engineering item in progress per implementer. A bounded device/inbox verification task can run alongside it when it does not contend for the same resource. Coordinate all hosted work through the shared release process.
5. Use the [reliability and error-budget policy](docs/reliability.md) to decide whether a release is admissible. A roadmap rank, feature vote or successful smoke test does not waive it.

**P1** means privacy, access, availability or a launch-critical requirement; **P2** means core experience or significant validation; **P3** means lower-urgency polish or exploration. These bands describe urgency, while queue rank selects the next action. An investigation remains an investigation until evidence confirms the cause. Open incident issues do not by themselves mean the service is currently down.

The owner’s explicit order below takes precedence over sorting by label alone; P1 reliability work remains visible in the remaining queue and can preempt on an active incident or release dependency. When proposing changes to that order, compare: current member harm; dependencies unlocked; strength of evidence; and the effort to reach the next verifiable result. Prefer a bounded reproduction or acceptance check over a speculative rewrite. When changing rank, record those reasons and any effort estimate in the issue. Do not invent numerical scores, reach estimates or delivery dates without evidence.

## Execution queue

Ranks continue across the sections below. This is an order for selecting work, not a promise to finish every item before taking any lower-ranked verification step.

### Owner top product priorities

Implementation is in progress on `codex/social-albums-experience`; no part of that branch is yet verified live. The branch separates Feed and Share, adds reading controls, and implements encrypted album metadata, member roles and ownership with database/HTTP tests. The independent-photo SQL foundation now tests direct/multiple-album grant unions and revocation. Encrypted photo publication/date-edit API tests now pass. Share Photos Only and album photo controls are implemented with retry/identity unit tests. Unified Feed photo browsing now combines independent photos and legacy attachments with API pagination/timezone tests. Owners can now add existing independent photos to albums, and album cards have authorized covers/counts. Owner signatures now bind photo metadata and bytes. Album admins can redistribute existing album photos to current eligible members with owner identity/direct access preserved, and additions run this sharing step with progress and retry. Post attachments now have signed editable photo dates at upload and afterward without changing post chronology or access. Legacy attachment album adoption, recovery/export/import, end-to-end acceptance and production promotion remain required; album screens are not a completed photo workflow yet.

The [Feed, Share, Photos and social albums design](design/feed-share-photos.md) records the latest proposed UI, audience defaults, album roles and unresolved permission details.

These rows follow the owner’s list. The two composer/navigation requests and the gear icon are one UI workstream. “Share” is the second-tab label from the explicit ordered list; “Post” describes its composer. The supplied sketch adds More as tab five, Post / Photos Only tabs inside Share, and Feed content/view/author filters. Use its handwritten numbering for order and the explicit Photos and Community names from the owner’s text.

| Rank | Issue | Priority | Requested outcome and next step |
| --- | --- | --- | --- |
| 1 | [#122 Community and Extended family](https://github.com/porchday/porchday/issues/122) | P2 | Community is friends/family of friends/family; Extended family is family of family. For both, a family edge requires **both sides** to label it family. Define two-hop eligibility and encrypted audience behavior; settle direct-member inclusion and history semantics before granting access. |
| 2 | [#123 First-class photos](https://github.com/porchday/porchday/issues/123) | P2 | Give photos an editable date at upload and later, and allow direct photo uploads without a post, through Share’s Photos Only tab or “Skip the post and add photos directly”. **Posts cannot have custom dates.** Define photo identity, date/calendar semantics and social albums with Read-only / Add / Album-admin roles. Album grants add to existing photo access; preserve attachment compatibility. |
| 3 | [#124 Navigation and sharing UI](https://github.com/porchday/porchday/issues/124) | P2 | Bottom nav: **Feed → Share → Albums → Connections → More**. Albums focuses on social photo albums; general photo browsing lives in Feed. Move Write a post from Feed into Share; make Settings a **gear**, not a sun. More contains Groups, Builder chat, Notifications, Settings and Feature additions. Share has Post / Photos Only tabs and a direct-photo shortcut (#123). Feed has Posts / Photos top tabs mirroring Share, plus Infinite scroll / Calendar and author-category filters (default Me, Friends & Family); preserve drafts, links and access boundaries. |
| 4 | [#125 Typed mentions](https://github.com/porchday/porchday/issues/125) | P2 | Make `@<id>` mentions resolve and render correctly in posts, photo captions and comments, using stable encrypted identity references. Build on existing tags; mentions never expand an audience. |
| 5 | [#7 App badges and mention push](https://github.com/porchday/porchday/issues/7) | P2 | Working red unread badges on the macOS Dock and mobile app icons. Mention/tag push for posts, captions and comments is **off by default**, independently of badges. Define unread/read and opt-in behavior, then verify actual signed-device delivery with #49/#114. |
| 6 | [#108 Calendar scroll direction](https://github.com/porchday/porchday/issues/108) | P2 | **Older months above, newer months below.** Load earlier months upward without moving the visible scroll anchor. Coordinate calendar placement with #123; preserve existing media/filter behavior and finish remaining device acceptance. |
| 7 | [#49 iOS through TestFlight](https://github.com/porchday/porchday/issues/49) | P2 | Deliver a processed, available TestFlight build and verify physical-device installation and recovery. App ID/capability registration is recorded; finish the App Store Connect record, signing/provisioning and distribution checks. Original parity simulator tests passed; verify the actual release candidate and report its scope. Compilation alone is not delivery. |
| 8 | [#114 Desktop through the Mac App Store](https://github.com/porchday/porchday/issues/114) | P2 | Publish an installable Mac App Store release. GitHub preview/README are complete. Shared SwiftUI iPhone/iPad/Mac is the selected direction, iOS first (#49); the owner requests retirement of the web wrapper. Finish native Mac implementation, signing, sandboxed Photos/export/key checks and store delivery. |

Design dependencies: #122 must preserve #22’s consent model; #123 informs #108’s calendar placement; #125 supplies eligible mention events for #7. Start Apple access/signing preparation for #49/#114 alongside product work because it can block device verification. Shipping either app does not imply every other priority is already complete; record the build scope explicitly.

### Remaining access and release reliability work

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 9 | [#40 Connection exhaustion and member-route 503s](https://github.com/porchday/porchday/issues/40) | P1 | Availability failures and exhausted connections were observed. Validate current connection headroom through representative traffic and a deployment; establish the remaining mechanism before changing capacity or topology. |
| 10 | [#1 Interrupted privacy operations](https://github.com/porchday/porchday/issues/1) | P1 | Interrupted work can block account access. Complete the outstanding hosted crash/recovery and in-flight checks while preserving protection for genuinely unknown outcomes. Coordinate load with #40. |
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

### Remaining polish

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 26 | [#18 Provider-injected analytics](https://github.com/porchday/porchday/issues/18) | P3 | Inspect the provider setting with the required access, suppress injection on exact application hosts, and verify clean browser traffic. Recorded CSP blocking is not evidence of a successful data leak; do not weaken CSP. |
| 27 | [#4 Emoji upload success wording](https://github.com/porchday/porchday/issues/4) | P3 | Make the message location-neutral and verify its accessible announcement and desktop/mobile placement. |
| 28 | [#15 Desktop icon cropping](https://github.com/porchday/porchday/issues/15) | Unset; recommend P3 | Reproduce on the affected desktop installation, adjust padding if needed, and verify the resulting icon rather than inferring from the source artwork. |

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

The emoji wording in #4 still exists in `apps/web/src/EmojiPicker.tsx`. #15 still needs installed-icon verification; #18 still needs provider cleanup. #22/#24/#28/#29/#41/#44 retain explicit member, device or hosted acceptance gaps. #1/#3/#8/#9/#40/#55 retain recovery, delivery, monitoring or measurement work; bounded successful releases do not discharge those criteria. Keep #52/#53 open as operational destinations, and preserve deferred features and unapproved proposals.

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
