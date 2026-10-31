# Feature proposal presentation

The board and its expandable proposal details use a versioned plain-text envelope
inside the existing `plan` field. Voting, approval and dispatch use their existing
records and APIs. Feed rendering is outside this change. No schema migration is
required, and old clients can still display the entire plain-text plan.

```
Proposal overview v1
Summary: One or two plain-language sentences, targeting at most 40 words.

Highlights:
- One to three concise behavior changes, benefits or material tradeoffs.

Original plan:
The complete authoritative plan, including scope, exclusions, acceptance,
testing, approach, rollout, rollback and provenance.
```

Put consequential policy exceptions, audience/privacy changes and costs in the
summary or highlights. Do not invent benefits or infer agreement. The bridge asks
for this format for future submissions, retaining the existing JSON protocol and
12,000-character plan limit. Unknown or malformed envelopes are never guessed:
their original text opens by default with a review notice. Native HTML details
provide keyboard expansion and accessible disclosure semantics. Supporting text
is grouped without discarding paragraphs; the exact original is always available.

## Existing proposals

Review each summary against the complete original, especially policy changes.
Keep the reviewed batch in a restricted private artifact directory, never a
public repository or static bundle. Its JSON array has `id`, `original`, `summary`
and `highlights` fields. `original` must match the current database plan exactly.
The preparation module rejects duplicate IDs, double wrapping, overlong plans,
overlong summaries and malformed envelopes rather than truncating requirements.

Use Node 24 with injected credentials, without printing environment values:

```
node scripts/feature-overview-migrate.ts staging check /private/reviewed.json /private/check-intent.json
node scripts/feature-overview-migrate.ts staging apply /private/reviewed.json /private/apply-intent.json
```

Use a staging-specific batch of owned fixture IDs. Do not copy production member
identities or private conversation records to staging. The CLI verifies the
configured database branch, takes the builder queue lock and row locks, checks
every original, and updates only `plan` in one transaction. It checks every other
feature column remains identical; it never writes votes or build messages. Any
stale original aborts the entire batch for review. `check` performs no updates.
The private intent records exact before/after text before the transaction starts.
A separate `.complete` marker records successful completion. If interrupted,
inspect current plans before proceeding; never retry automatically or overwrite
an intent file. A missing completion marker does not prove the transaction failed.

## Rollout and rollback

Validate representative structured, legacy and policy-changing fixtures on staging,
including voting, dispatch and expanded details. Promote the web presentation
through the maintained release controller using the latest verified runtime and
retained asset union. Do not deploy unrelated main-branch changes. Apply reviewed
production summaries only after release admission, then update the bridge through
its normal graceful restart so subsequent plans use the envelope. No API rollout
is required. Verify existing IDs, status, votes and exact originals after the data
change. The error-budget feature hold still applies independently of voting approval.

For a data rollback, use the same reviewed input and a new private receipt:

```
node scripts/feature-overview-migrate.ts production rollback /private/reviewed.json /private/rollback-intent.json
```

This restores only exact matching envelopes to their original plans; changed plans
stop the batch. Do not erase votes, approval state or future submissions. Use the
normal builder-chat rollback command for code and the maintained prepared asset
rollback for deployment. Old clients can display newly generated envelopes intact.

## Verification

Run the proposal, bridge and data-preparation tests, web/bridge typechecks, web
build, and `node scripts/check-feature-overviews.mjs` in Chromium and with
`TEST_BROWSER=webkit`. The browser check exercises real card controls, Enter/Space
expansion, accessible names, exact original text and widths 320, 390 and 1280.
It does not establish a physical-device screen-reader or hosted rollout pass.

The implementation turn prepared and reviewed eight existing summaries privately.
No production data rewrite or feature deployment is claimed by local validation.
Track remaining staging/data/release verification in issue #44.
