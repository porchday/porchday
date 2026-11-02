# Porchday roadmap

Make the invitation-only pilot dependable, finish the core member experience, then expand it. This is the repository's authoritative order of work. GitHub Issues hold acceptance criteria, implementation status and evidence; this file explains what comes next and why. A merged change to this file changes the default order. It does not authorize deployment, broaden admission or override an issue's approval requirements.

Last reviewed: **November 1, 2026**. Covers the 36 open product-backlog issues at that review. Priority labels below reflect GitHub labels; #15 has no priority label yet. Status summaries are a dated snapshot, so read the linked issue's recent evidence before starting.

## How to choose the next task

1. An active outage, credible security report or risk of losing access to encrypted content takes precedence. Handle sensitive reports through [SECURITY.md](SECURITY.md).
2. Otherwise, take the highest-ranked **ready next step** in the execution queue. A missing device, recipient response, signing identity or external decision can block that step; record the blocker in its issue and work on the next ready item. Preparation and investigation can proceed before a dependency is resolved; promotion cannot skip its gates.
3. Prioritize completion and verification of existing work over starting another implementation of it. `needs verification` means determine what evidence is missing, not assume either “unbuilt” or “done.”
4. Keep one primary engineering item in progress per implementer. A bounded device/inbox verification task can run alongside it when it does not contend for the same resource. Coordinate all hosted work through the shared release process.
5. Use the [reliability and error-budget policy](docs/reliability.md) to decide whether a release is admissible. A roadmap rank, feature vote or successful smoke test does not waive it.

**P1** means privacy, access, availability or a launch-critical requirement; **P2** means core experience or significant validation; **P3** means lower-urgency polish or exploration. These bands describe urgency, while queue rank selects the next action. An investigation remains an investigation until evidence confirms the cause. Open incident issues do not by themselves mean the service is currently down.

Within a priority band, compare: current member harm; dependencies unlocked; strength of evidence; and the effort to reach the next verifiable result. Prefer a bounded reproduction or acceptance check over a speculative rewrite. When changing rank, record those reasons and any effort estimate in the issue. Do not invent numerical scores, reach estimates or delivery dates without evidence.

## Execution queue

Ranks continue across the sections below. This is an order for selecting work, not a promise to finish every item before taking any lower-ranked verification step.

### First protect access and reliable releases

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 1 | [#40 Connection exhaustion and member-route 503s](https://github.com/porchday/porchday/issues/40) | P1 | Availability failures and exhausted connections were observed. Validate current connection headroom through representative traffic and a deployment; establish the remaining mechanism before changing capacity or topology. |
| 2 | [#1 Interrupted privacy operations](https://github.com/porchday/porchday/issues/1) | P1 | Interrupted work can block account access. Complete the outstanding hosted crash/recovery and in-flight checks while preserving protection for genuinely unknown outcomes. Coordinate load with #40. |
| 3 | [#55 Logout latency and journey deadlines](https://github.com/porchday/porchday/issues/55) | P1 | Resolve a measured source of failed journeys. Use phase evidence to separate server, pool and network delay; verify old-cookie rejection without merely relaxing deadlines. |
| 4 | [#3 Repeatable release verification](https://github.com/porchday/porchday/issues/3) | P1 | Every change depends on safe delivery. Consolidate remaining private orchestration into the maintained release path, preserve bounded failure diagnostics, and verify recovery/adoption gaps. Existing successful releases are evidence, not a reason to rebuild the controller. |
| 5 | [#2 Signup configuration guard](https://github.com/porchday/porchday/issues/2) | P1 | A small guard prevents recurring loss of invited signup. Compare checked-in deployment configuration with generated approved settings in CI and preflight. Integrate with #3. |
| 6 | [#8 Alert delivery and independent detection](https://github.com/porchday/porchday/issues/8) | P1 | Confirm remaining channels, responder receipt and independent coverage. Track the Mac and GitHub notification destinations under this work; avoid counting them as separate product features. |
| 7 | [#22 Directional history sharing](https://github.com/porchday/porchday/issues/22) | P1 | This is a consent and encrypted-access contract. Reconcile existing implementation/release evidence and finish outstanding hosted/native acceptance, including future-only recipients and revoked access. Do not silently change existing consent. |

### Then complete the core pilot experience

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 8 | [#27 Invitation signup rejection](https://github.com/porchday/porchday/issues/27) | P2 | A reported signup blocker needs recipient evidence. Confirm the submitted destination/error privately and verify actionable guidance. Do not assume premature consumption or replace a valid invitation without cause. |
| 9 | [#88 Background profile setup after recovery](https://github.com/porchday/porchday/issues/88) | P2 | Reproduce through supported account setup to distinguish fixture behavior from a member-facing defect. Confirm the existing write before retrying it. |
| 10 | [#19 Six-member end-to-end acceptance](https://github.com/porchday/porchday/issues/19) | P2 | Establish that social flows work together. Run isolated accounts through connections, audience changes, history sharing, media and deletion; use #22 and #88 findings to explain failures. |
| 11 | [#9 Capacity, mobile performance and cost](https://github.com/porchday/porchday/issues/9) | P2 | Establish a measured pilot envelope rather than extrapolating smoke tests. Start with representative workloads and headroom; coordinate disruptive load with #40 and the release owner. |
| 12 | [#6 Accessibility acceptance](https://github.com/porchday/porchday/issues/6) | P2 | Complete real VoiceOver/NVDA and mobile checks of core flows. File observed defects separately and promote any access-blocking defect on its evidence. |
| 13 | [#114 macOS distribution and device acceptance](https://github.com/porchday/porchday/issues/114) | P2 | The downloadable preview exists. Finish real installation, history recovery, Photos selection and export checks; signing/TestFlight work needs the actual Apple credentials and installed-build evidence. |
| 14 | [#24 Photo import compatibility](https://github.com/porchday/porchday/issues/24) | P2 | Build on the implemented decoder coverage. Verify remaining original-photo/device cases without weakening encrypted received-media validation. |
| 15 | [#108 Calendar and encrypted video acceptance](https://github.com/porchday/porchday/issues/108) | P2 | Web rollout is verified. Finish real iPhone MOV/HEVC, native and installed-service-worker checks; retain documented size/codec limits. Larger uploads are separate scope. |
| 16 | [#49 iOS parity and installation](https://github.com/porchday/porchday/issues/49) | P2 | Reconcile current simulator/build evidence, finish supported signing/install steps and explicitly assess browser handoffs. Native builder chat remains postponed. |
| 17 | [#7 Device migration, notifications and links](https://github.com/porchday/porchday/issues/7) | P2 | Use working signed builds and real devices to prove history recovery, push and link behavior. Preserve existing .com keys/installations until migration is verified. Shares device sessions with #49/#114. |
| 18 | [#29 Builder chat acceptance](https://github.com/porchday/porchday/issues/29) | P2 | Finish member-facing end-to-end and rollback acceptance of the existing bridge before expanding its scope or allowlist. |
| 19 | [#44 Feature additions and voting](https://github.com/porchday/porchday/issues/44) | P2 | Reconcile delivered board/feed work with hosted acceptance. Verify authorization, concurrent voting and single dispatch before depending on it for further proposals. |
| 20 | [#41 Group invitation visibility and selection](https://github.com/porchday/porchday/issues/41) | P2 | Build on recorded staging acceptance. Reconcile production evidence and finish the remaining owner/non-owner and invitation lifecycle checks. |
| 21 | [#28 Profile photos across the product](https://github.com/porchday/porchday/issues/28) | P2 | Finish remaining surface/device verification, including removal, inaccessible-photo fallback and stale-request cleanup. Reuse implemented behavior rather than duplicating it. |

### Then polish

| Rank | Issue | Priority | Why this order and the next verifiable step |
| --- | --- | --- | --- |
| 22 | [#18 Provider-injected analytics](https://github.com/porchday/porchday/issues/18) | P3 | Inspect the provider setting with the required access, suppress injection on exact application hosts, and verify clean browser traffic. Recorded CSP blocking is not evidence of a successful data leak; do not weaken CSP. |
| 23 | [#4 Emoji upload success wording](https://github.com/porchday/porchday/issues/4) | P3 | Make the message location-neutral and verify its accessible announcement and desktop/mobile placement. |
| 24 | [#15 Desktop icon cropping](https://github.com/porchday/porchday/issues/15) | Unset; recommend P3 | Reproduce on the affected desktop installation, adjust padding if needed, and verify the resulting icon rather than inferring from the source artwork. |

## Milestones and standing operational threads

These do not consume additional queue slots for engineering already ranked above. Start external scheduling early when it has a long lead time.

| Issue | Role | Completion or ongoing requirement |
| --- | --- | --- |
| [#42 Demonstrate 99.99% availability](https://github.com/porchday/porchday/issues/42) | P1 reliability milestone | Depends on recovery, capacity, delivery and monitoring work (#1/#40/#55/#3/#8/#9). Require the complete measured window and disclosed coverage in the reliability policy. Keep collecting evidence while engineering proceeds. |
| [#10 Broader launch readiness](https://github.com/porchday/porchday/issues/10) | P1 admission milestone | Independent security review, recovery/moderation coverage, accurate operator disclosures and operating-budget decisions remain distinct gates. Schedule review early; reconcile already-completed source-publication evidence instead of treating publication as unstarted. This does not disable the authorized invitation pilot. |
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

## Keeping this definitive

- Update this file in the same PR as a material change in scope, dependency, priority, deferral or completion. For changes recorded directly in GitHub, reconcile the roadmap in the next repository update before choosing new backlog work. Check it during weekly planning; this is a review practice, not an installed scheduled job.
- Every new open product issue gets one primary row here. Link related issues as dependencies instead of creating competing queue entries for the same work. Put operational notification threads and milestone trackers in their separate section.
- The issue owns detailed status and acceptance evidence. The roadmap owns rank and the next step. If they disagree, reconcile the newer evidence and record the decision; do not silently assume the easier interpretation.
- When changing priority, update the issue label and this file together and leave a short reason in the issue. Distinguish an owner-directed reprioritization from a recommendation still awaiting a decision. Retain `deferred` until scope is explicitly reopened.
- For a blocked item, record the exact missing dependency, the next action and the responsible person when actually assigned. Do not invent owners or dates. Continue independent ready work rather than leaving the whole queue idle.
- Remove completed product issues from the queue only when their acceptance criteria are verified. Put commit, tests and deployment/device evidence in the issue; retain `needs verification` for outstanding checks. Closed issues and [CHANGELOG.md](CHANGELOG.md) hold the history rather than an ever-growing “done” list here.
- A merged PR is not a deployed feature. Track small follow-up PRs on their issue even when the parent work is complete, and give any unfinished delivery step an explicit place in the issue or queue.

Roadmap maintenance is tracked in [#120](https://github.com/porchday/porchday/issues/120). The initial ranking is an editorial planning decision based on the linked backlog, not an effort estimate or a new grant of operational authority.
