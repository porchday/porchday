## Objective

Determine whether the reported full-calendar WebKit reading-anchor failure reflects measurement timing, scroll-range clamping or a production anchoring defect. Priority: P2 investigation; production impact and root cause are unverified. Deliver evidence and a bounded recommendation before proposing implementation.

## Origin and context

Bobby requested this investigation on November 22, 2026. Read the authorized shared outcome of job `8bde2b42-d304-4e99-9d6c-6334d123f9ea` in [Correct photo-calendar invitation fixture](../e0cab286-0d93-4f28-b3c6-b4f602ec2fdd/task.md).

Related context: [Thanksgiving candidate validation](../460c54df-49ef-42d5-8bc6-20b7b4c4f21b/task.md), [#108 calendar scrolling](https://github.com/porchday/porchday/issues/108), [#211 Thanksgiving](https://github.com/porchday/porchday/issues/211) and [#94 integration](https://github.com/porchday/porchday/issues/94).

Operator-reported host operation `b3ab4560-ec5f-4631-8c28-618b1f4aecc0`, snapshot `59938e65d73dc942eb4a7f504adcf2df99faffee37673b0570df36a1339ea3c2`, passed format and full Chromium. Full WebKit failed `scripts/check-photo-calendar.mjs:207`: anchor position before `365.796875`, after `434.796875` (69 pixels).

The shared outcome reports that the calendar assertions, `PhotosCalendar.tsx`, `calendar-scroll-anchor.ts` and relevant CSS are unchanged from baseline `a751067`. The failing phase mounts PhotosCalendar directly before the repaired invitation flow. No causal path from the invitation correction was identified; this does not establish the actual cause.

Current task inventory contains no matching investigation. GitHub open/closed issue search returned HTTP 401. No remote issue was created or updated; reconcile existing #108 and search again before creating new issue tracking.

## Scope

- Confirm the host receipt's exact full-WebKit command and record candidate commit plus working patch/hash, baseline commit, browser/Playwright version, OS, viewport, timezone/date and synthetic fixture inputs.
- Compare candidate and baseline `a751067` full-calendar WebKit under matched browser, viewport and date conditions. Use an authorized host environment where sandbox browser execution is unavailable. Retain the original failure and record every comparison run rather than retrying until a pass.
- Capture a bounded timeline around prepending the earlier month: original/saved anchor identity and position, month count, loading transitions, IntersectionObserver-triggered requests, response/render completion, layout-effect corrections, ResizeObserver callbacks and adjustments, `scrollY`, document height, viewport height and maximum scroll range.
- Measure both the initial prepend and subsequent photo-loading phases, distinguishing transient displacement from persistent drift and attempted scroll adjustments from clamped results.
- Assess whether the current two-animation-frame wait measures a settled state. Investigate synchronization without changing the existing assertions or tolerance.
- Return a supported diagnosis or explicitly bounded inconclusive result. Propose the smallest appropriate fixture synchronization correction or separately scoped production bug fix only after evidence supports it.

This is investigation only. Diagnostic instrumentation must be isolated and disclosed, with no production behavior changes. Preserve both anchor assertions and their existing tolerance. Do not make unrelated fixes or rewrite permanent design documents.

Maintained CI and the fixture task require full Chromium plus `DRAFTS_ONLY=1 DRAFTS_BROWSER=webkit`. Those modes are checked separately by the existing task; their success would not resolve this full-calendar failure. Do not change either existing task's acceptance criteria or add a dependency cycle. These links are context, not new execution prerequisites.

## Acceptance criteria

- Candidate and baseline identities and matched environment/input details are recorded, including exact commands and any mismatches that limit comparison.
- Full-calendar WebKit comparison results cover both existing anchor assertions without weakening, removing or increasing their tolerance.
- Evidence captures loading/render transitions, saved anchors, scroll range and ResizeObserver adjustments sufficiently to evaluate timing, clamping and persistent drift, or explains precisely which observations remain unavailable.
- The report distinguishes observed facts, hypotheses and production impact. Unchanged source alone is not treated as proof of baseline reproduction or harmlessness.
- A supported recommendation identifies whether a fixture synchronization fix, production bug investigation/fix or further bounded experiment is needed. No implementation is silently included.
- Original host failure remains recorded. Required Chromium/drafts-only WebKit results, full-calendar results, human acceptance and deployment remain separate.
- Bobby explicitly reviews the outcome through the application; do not mark the task accepted or done automatically.

## Implementation status

Planned and unverified. No implementation, browser rerun or task dispatch occurred in this main-chat turn. Automatic task execution is disabled. Execution and any controlled host operations require their usual authorization; task creation grants no commit, publication, CI dispatch, runtime-change or deployment authority.

## Verification evidence

The shared outcome was read from the authorized project context archive, not raw provider logs. It records:

- Fixture SHA-256 `23b5252d8376a495b7bdd7b0cc203c3605e49adb45e208c49f9303016ec1261c` at inspection, with only four invitation-related changed lines.
- The fixture waits for the original month's photo/loading state, then prepends a month and waits for increased month count plus two animation frames before the failing assertion. New-month loading and rendering waits occur afterward.
- The production hook saves the original month position, adjusts in a layout effect and uses ResizeObserver for later size changes.
- Timing, scroll-range clamping and an actual anchoring defect remain plausible, unverified explanations. No browser checks were rerun in that investigation outcome.

These are recorded source observations and operator-reported host results, not a reproduced baseline comparison. ROADMAP links preservation of the visible calendar anchor to #108.

## Human acceptance

Not human-accepted. Explicit application sign-off is required. Neither existing task is accepted or closed by creating this investigation. No deployment or production verification is claimed.

## Open questions

- Does baseline `a751067` reproduce the same displacement under the identical full-WebKit environment?
- Is displacement transient during loading or persistent after all corrections settle?
- Are scroll adjustments clamped by the available scroll range, delayed by rendering/observer ordering, or incorrect?
- Which evidence supports a fixture synchronization change versus a production behavior fix?
- Remote issue reconciliation remains pending because GitHub search returned 401.
