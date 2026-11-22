## Objective

Correct the synthetic invitation response and Connections readiness checks in `scripts/check-photo-calendar.mjs`, preserving the Share composer identity and draft-retention regression assertions. Priority: P2.

This correction is a prerequisite to completing [Thanksgiving candidate validation](../460c54df-49ef-42d5-8bc6-20b7b4c4f21b/task.md). Keep that task active. This task has no prerequisite on its parent validation task; do not create a dependency cycle.

## Origin and context

Bobby's operator desktop bug-fix request, November 22, 2026, outside feature voting. Main CI [run 44965673018](https://github.com/porchday/porchday/actions/runs/44965673018) failed the Share composer stays mounted assertion on `e3742f498a83c4176a179800d9a2159b1a88795c`. The operator reports native checks passed for that source; main CI remains failed and the candidate is not accepted.

Related tracking: [#211 Thanksgiving](https://github.com/porchday/porchday/issues/211), [#94 Small Potato integration](https://github.com/porchday/porchday/issues/94).

The requested investigation is task `460c54df-49ef-42d5-8bc6-20b7b4c4f21b`, job `3ac9d0eb-fc79-486f-b34e-8b5de5ecc0ad`. Its completed outcome was not present in the supplied shared-context archives or current task document inspected in main chat. Do not claim that outcome was read. The operator's summary and direct source inspection support this bounded scope; retrieve the recorded outcome through authorized project records before implementation if available, without reading agent transcripts or raw session logs.

Duplicate review found only the historical Thanksgiving task and active validation task. Neither represents this implementation correction. GitHub issue search returned HTTP 401; remote duplicate status is unknown and no issue was created.

## Scope

- Add a synthetic GET handler for `/api/v1/platform-invitations`, including requests with the existing query string, returning `{items: [], next_cursor: null}`.
- After navigating from Share to Connections, wait for the exact visible text `No invitations yet.` and assert that captured browser errors are empty before navigating back to Share.
- Preserve the existing same-composer-node identity assertion, retained text, attachment count, reload restoration and date assertions, and existing error checks.
- Keep changes confined to the test fixture and necessary task evidence. Do not change production UI/API behavior, suppress errors, weaken assertions, add arbitrary sleeps or rewrite unrelated design documents.
- Run the maintained format and photo-calendar checks through an authorized execution environment. Use a permitted host operation when sandbox restrictions prevent browser execution; retain failed attempts as evidence.
- After separately authorized publication, renew main and both native CI evidence for the exact corrected commit. Retain usual source-bound operation and release gates.

Task creation does not dispatch execution. No commits, pushes, CI dispatch, credential access, infrastructure/runtime changes, deployment or production-data access are authorized by this planning action.

## Acceptance criteria

- The synthetic GET response matches `apps/api/src/platform-invitations.ts`: an empty `items` array and `next_cursor: null`. Production source remains unchanged.
- The Connections empty state is observed and captured browser errors are checked before returning to Share.
- All existing composer identity and draft-retention assertions remain intact and pass; the test still detects remounting or lost drafts.
- `python3 scripts/check-format.py` and the maintained `scripts/check-photo-calendar.mjs` browser checks pass in the required configured modes, using an authorized host check where needed. Record commands, source identity, results and limitations.
- Following separately authorized publication, successful main, iOS simulator and macOS CI runs are tied to the exact corrected commit. Old native results cannot satisfy this requirement. Missing authorization or failed checks remain explicit blockers.
- Return evidence to the active Thanksgiving validation task before it is presented as fully validated. This fix does not waive that task's other browser, parity or review criteria.
- Preserve prior failures and distinguish implementation, local verification, publication, CI, human acceptance and deployment.

## Implementation status

Implemented locally under Bobby's explicit implementation request of November 22, 2026; not committed or published. The workspace remains based on `e3742f498a83c4176a179800d9a2159b1a88795c`. Initial inspection found the task directory untracked and no tracked source modifications. The final tracked diff contains only four added lines in `scripts/check-photo-calendar.mjs`:

- A GET-only handler matches the parsed URL pathname `/api/v1/platform-invitations`, so the existing `?v=2` query is supported, and returns `{ items: [], next_cursor: null }`.
- The route regression waits for the exact visible Connections empty state and asserts captured browser errors are empty before returning to Share.

Diff review confirms all existing composer identity, retained text, attachment count, reload restoration, date and final error assertions remain unchanged. Production source is unchanged. The task remains active pending host browser checks, exact-source CI and human acceptance.

## Verification evidence

Historical planning inspection found the missing handler and immediate switch back to Share. The operator subsequently supplied the investigation summary: the catch-all `{ok:true}` response provides no `items` to `PlatformInvitation`, which can crash/remount the shell. That diagnosis is source-supported and operator-reported; the original investigation outcome was not independently read in this implementation turn. Its reported sandbox denial and failed main CI run remain historical evidence, not successful verification.

Implementation-turn source inspection confirmed:

- `apps/api/src/platform-invitations.ts` returns `{items, next_cursor}`, with `null` when no next page exists.
- `apps/web/src/PlatformInvitation.tsx` requests `/platform-invitations?v=2` and renders `No invitations yet.` for an empty list.
- `.github/workflows/ci.yml` configures the full default Chromium check and a WebKit drafts-only check.

Checks run directly against the corrected local source, based on `e3742f498a83c4176a179800d9a2159b1a88795c`, with `scripts/check-photo-calendar.mjs` SHA-256 `23b5252d8376a495b7bdd7b0cc203c3605e49adb45e208c49f9303016ec1261c`:

- `python3 scripts/check-format.py`: passed, reporting `First-party text formatting checks passed.`
- `git diff --check`: passed with no output.
- `node --check scripts/check-photo-calendar.mjs`: passed with no output.
- `node scripts/check-photo-calendar.mjs`: failed with exit 1 at server startup, `listen EPERM: operation not permitted 127.0.0.1`, under Node.js v24.14.0. The browser did not launch and no browser assertions were verified. This denied operation was not retried; the WebKit mode was not attempted.

These are direct local checks, not configured host-operation receipts. The proposed task-document update has not yet been applied by the application and is not covered by the preceding format result. No source changes followed these checks.

Required follow-up through the separately authorized Small Potato host operation: run `node scripts/check-photo-calendar.mjs` and `DRAFTS_ONLY=1 DRAFTS_BROWSER=webkit node scripts/check-photo-calendar.mjs`, retaining source-bound receipts. Following separately authorized publication, renew main, iOS simulator and macOS CI for the exact corrected commit and return evidence to the active Thanksgiving validation task. Prior native passes do not satisfy the corrected-source requirement.

No commits, pushes, credential access, CI dispatch, infrastructure changes, deployment or production-data access occurred. GitHub tracking was not updated; the previous reconciliation gap remains open.

## Human acceptance

Not human-accepted. Bobby's explicit application sign-off remains required; neither task creation nor successful checks accept this task or the Thanksgiving candidate. Publication and deployment require separate authority.

## Open questions

- The complete investigation outcome is absent from the supplied archive; retain this evidence gap and obtain the authorized project outcome when available.
- Application-level dependency metadata for the existing validation task must be linked to this task once its ID is assigned. The current structured action schema cannot modify an existing task's `dependsOn`; the prerequisite is recorded here without claiming an enforced queue dependency.
- Remote issue reconciliation remains pending because GitHub search was unauthorized. Reuse matching existing tracking and search before creating any new issue.
- Exact-source CI renewal awaits separately authorized publication and controlled checks.
