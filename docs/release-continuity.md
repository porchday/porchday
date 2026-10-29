# Existing-session observation during releases

## Command lifecycle coordination

`scripts/release-continuity-command.ts` exports `runCommandWithContinuity` for
new release harnesses. It accepts the same probe target/scope checks, a durable
append-only `retain(event)` sink and a `runCommand(signal)` callback invoking the
reviewed activation command exactly once. Supply the existing operation's
manifest and journal; this wrapper does not authorize replay of a prior run.

The wrapper retains a healthy baseline and command intent before calling the
command. A failed baseline, lost scope or failed evidence write prevents that
invocation. It captures each sample's phase at its start, so a sample that spans
command completion cannot count toward the two required post-command samples.
It retains the actual command-settlement time and fixed terminal status without
raw command errors. A rejected callback also retains `failureCode`: an exact
allowlisted diagnostic (including reader-floor and CI rejection) or
`COMMAND_ERROR_REDACTED`. Arbitrary messages, stacks, causes, credential-like
values and message getters are not copied. This diagnostic does not authorize
repeating the command. Failed samples, sample exhaustion, interrupted observation,
failed retention and unverified command outcomes reject acceptance. A verified
rollback returns `rolled-back`, distinctly from `complete` promotion.

On any exit it cancels and awaits the command before returning control for
fixture cleanup. The callback must honor cancellation and settle only after all
child processes and callbacks have stopped; wrapping a detached subprocess is
invalid. This wrapper cannot force an arbitrary callback to honor that contract.
The underlying release command still owns bounded execution, leases, one-shot
provider intents, rollback and unknown-outcome reconciliation. An observation
failure after activation does not itself authorize another provider write.

The maintained observed activation entry points additionally connect samples to a
durable promotion gate in `scripts/release-continuity-gate.ts`. The first failed
sample writes an operation/plan-scoped private record before the caller's sample
sink runs. Later healthy observations cannot clear it. Recovery, including an
explicit resume without the observer, reads this same record. A prepared failure
prevents dispatch; a last-boundary failure after intent remains unconfirmed and
cannot be replayed. A failure while the candidate is being verified routes through
the existing compatibility-checked, one-shot rollback and baseline verification.
Candidate completion and canonical finalization also check the gate.

A failure after the controller has written its terminal outcome is a separate
attention state: the terminal journal is not rewritten, and no fresh deployment
is invented. Before canonical finalization, the gate holds promotion for explicit
reconciliation. If a durable finalization receipt already exists, its historical
completion can be reconciled, but the command does not report successful promotion
when a continuity failure is retained. The release watch preserves the queued
owner alert even after terminal archival. Operators must inspect the original
operation and current provider state, then prepare a separately reviewed recovery
only after resolving that disposition. Never delete the failure marker to make
acceptance pass. A failed rehearsal remains failed even if rollback is verified.

Retain the command's own provider/journal milestones as well. Healthy samples
around command execution do not independently prove which version was serving,
that a candidate was reached, or that browser/native/schema overlap worked. The
wrapper has been used by the observed activation entry point in the
[staging backend feature release](evidence/group-invitation-staging-continuity-2026-10-29.md)
and monitor releases. That evidence does not establish browser/native overlap
or adoption by every release caller. Remaining acceptance stays tracked in #3.

Local validation on October 29: the full suite passed 1,161 general tests and
22 crypto tests, with 193 environment-dependent tests skipped. Fifteen new
coordinator cases cover baseline/sink/scope rejection before dispatch, sample
start-phase accounting, cancellation and joining the command, exhausted coverage,
failed samples, command rejection, terminal-evidence failure and rollback status.
Deployment-tooling type checking, native Node import, formatting and secret scans
also passed. These tests use synthetic transports and make no provider writes.

## Maintained activation integration

New harnesses can call `executeActivationWithContinuity(manifest, env,
observation, signal)` from `scripts/release-activation-cli.ts`. This binds the
coordinator to `executeActivationManifest`, including fixture preflight, exact
source/CI/artifact/schema gates, real shared leases, durable provider/journey
intents, recovery, final evidence and canonical finalization. It registers the
independent release watch, rejects a mismatched observation environment, and
refuses to manufacture new coverage for an operation already past `prepared`.
Interrupted operations must use their original explicit reconciliation path.

The observation object supplies pinned synthetic sessions, `assertScope`, and a
durable `retain` sink as described above; it cannot substitute a deployment
callback. Check fixture lifetime, immutable input pins and ownership during lease
handoff/finalization in `assertScope`. Preserve provider milestones and the
original operation's journals. Do not clean fixtures while the returned promise
is pending, and do not replay it after an unknown result. An archived completion
is historical evidence, never a new observed activation.

Composition tests use the actual activation controller, file journals, SQLite
lease, canonical finalization and continuity probes with simulated provider/DB
boundaries. They cover successful activation despite a lost provider reply,
preflight rejection with zero deployment/login writes, and rejection of an
already completed operation before any new request. The command-line `activate`
entry remains available for original operation reconciliation; hosted adoption
of this new observed entry point remains outstanding.

## Probe and watch primitives

`scripts/release-continuity.ts` provides a bounded read-only observer for a
synthetic session that existed before activation. It complements the durable
login/logout journey in `release-journey.ts`; neither replaces the release's
source, CI, artifact, schema, asset or provider-state gates.

Each sample checks authorized profile ownership, an empty synthetic feed,
rejection of a separately revoked cookie, and protected readiness. Responses for
authorized reads must be uncacheable. Only fixed check names, statuses, durations,
timestamps and booleans leave the observer. No response body, member ID, cookie,
health token or raw error is returned. Requests use fixed environment origins,
GET only, redirects disabled, a shared five-second default deadline and a
64-KiB response-body limit. The configurable deadline cannot exceed ten seconds.
Stalled transports/bodies are bounded; late replies cannot revive a failed sample.

`watchReleaseContinuity` defaults to a two-second interval and at most 120
samples. It awaits retention before starting the next sample, so slow checks or
storage create a visible larger sampling gap rather than overlapping work or
catch-up bursts. Stop is checked between samples; an in-flight sample completes
and is retained. Caller cancellation, scope loss or a failed evidence write
rejects the watch. Sample exhaustion is a distinct result, not a successful
completion. Failed samples remain in the result count. No login/logout, provider
mutation, retry, rollback or approval occurs in this observer.

For a hosted rehearsal:

1. Pin the release plan and exact runtime/tooling sources. Acquire the existing
   release lease and establish isolated fixtures through the durable one-shot
   login/logout protocol. Keep the allowed session valid across the switch and
   retain the separate revoked cookie privately. A denied cookie alone does not
   prove that a SQL row was retained; the rollback drill's separate row check is
   still required.
2. Supply `assertScope` that checks the current lease/plan and fixture lifetime.
   It runs before dispatch, at response/body boundaries and between samples.
   Supply a durable append-only sample sink scoped to this release. Never write
   fixture credentials or raw responses into ordinary evidence.
3. Retain a healthy baseline sample before activation. Run the watch alongside
   the reviewed activation command and preserve its real release-journal
   milestones. Use the original transport for observations when the fault drill
   locally injects a readiness result into the release verifier.
4. Continue through activation and any compatible rollback until post-release
   samples are retained. Stop the observer before revoking/removing its allowed
   fixture. Reconcile every uncertain mutation using the existing release and
   fixture ledgers; this observer does not authorize replay.
5. Report the sampled window, cadence/gaps, failures and milestone coverage.
   Verify that the activation and recovery actually fall inside that window.
   An empty window, sample-limit termination or missing evidence cannot establish
   continuity. Do not convert `maxStartGapMs` into an outage duration or claim
   continuous availability between successful probes.

The library's local tests cover read authorization, denial, readiness, deadlines,
late responses, retention failures, scope loss and credential redaction. The staging rehearsal below provides scoped hosted integration evidence. It
does not prove a normal feature deployment,
browser/native client overlap, backward-compatible schema changes or production
continuity. Those remain acceptance criteria in issue #3.


## Hosted staging rollback rehearsal — October 29

Runtime `8634c17` passed a real activation and automatic rollback from flag-only
candidate `5259bcf4` to baseline `2120ff4c`. The candidate used identical API
code/schema/assets with writer and cleanup disabled. A local failed readiness
observation triggered the real provider rollback. The independent observer used
the original transport and retained 17 healthy samples between 12:46:31.238 and
12:47:03.655 UTC, with a maximum start gap of 2,003.971 milliseconds. A baseline
sample completed before dispatch; samples covered candidate state and two began
after the command completed in rolled-back state.
[Evidence](evidence/session-denial-refill-continuity-rollback-staging-2026-10-29.json).

Both versions rejected the revoked cookie while its SQL row remained and allowed
the unrelated synthetic member. After releasing the identity lock, scheduled
cleanup removed the retained row within 45.368 seconds and completed a new pass.
Exact fixture cleanup verified zero rows, the provider was restored and the lease
released. Production Workers were unchanged. This proves the stated sampled
flag-only rollback scope; normal feature rollout, old/new browser/native clients,
compatible schema changes and production continuity still require evidence.

## Hosted staging code activation — October 29, 13:01 UTC

Diagnostic runtime `770071b` was activated as `c0b3699a`, replacing `2120ff4c`
without changing schema, frontend assets or protocol. The existing allowed
session and revoked cookie spanned the code change. Fourteen samples were healthy
from 13:01:25.789 through 13:01:52.392 UTC; maximum start gap was 2,003 milliseconds.
One baseline completed before dispatch, candidate-phase samples were retained,
and two samples began after command exit in complete state. Release journeys,
provider/schema/artifacts and 31 retained assets passed; exact fixture cleanup
left zero rows and released the lease. Production Workers were unchanged.
[Evidence](evidence/logout-prejournal-continuity-staging-2026-10-29.json).

This adds actual backend code activation coverage to the separate flag-only
rollback rehearsal. It does not establish frontend/native client or schema
overlap, unsampled continuity, production rollout or the monthly SLO.

## Production diagnostic rollout rejected — October29,13:10UTC

Candidate `ed3f2b7e` / `c2f8bf5` was activated, but the pinned release probe
referenced a deleted synthetic account. Its login outcome was not retained and
remains unknown; it was not replayed. Seven independent existing-session
samples were healthy before the verifier stopped. This is not accepted release
continuity or evidence of an application outage.

Operator-directed recovery restored `f613874a` / `ebc567a4` under the same
deployment operation. A baseline-only durable journey with the separately
verified fixture passed; exact fixture cleanup and provider reconciliation
completed, releasing the lease. A local recovery directory omission was corrected
before that baseline journey began; no deployment write was repeated.
[Evidence](evidence/logout-prejournal-production-rollback-2026-10-29.json).

Before another rollout, require pinned synthetic identity existence and ownership
to be checked before activation. Preserve unknown login evidence and use explicit
reviewed recovery for unavailable verification. Production diagnostics remain
undeployed. This failure is tracked in issue #3; investigation #55 remains open.

## Verification fixture preflight

The activation CLI checks its pinned probe fixture after existing release
authorization and before the controller records an activation intent. A bounded
read-only database transaction verifies the exact ID/email, verified-email flag,
member status and presence of a password credential account. The query returns
only a boolean, never passwords, hashes, IDs or member records. Missing fixtures,
read failures and cancellation stop activation without a provider write.

The gate runs only for a new activation authorization. Rollback and reconciliation
of an already-dispatched activation do not rerun it or replay login/deployment
requests. A preflight rejection remains cancellable through the existing
pre-intent cancellation path; preserve its evidence. The normal post-activation
journey is still mandatory: this check cannot establish password correctness,
prevent later fixture deletion or prove application health.

The hosted read-only check rejected the deleted release fixture and accepted
the active monitor fixture without login or database/provider writes.
[Evidence](evidence/release-probe-preflight-2026-10-29.json).

## Production diagnostic activation verified — October29,13:26UTC

Fresh operation `2538dee7` activated `3896cab5` / runtime `c2f8bf5` with
tooling `3599019` and the fixture preflight gate. The pinned active monitor
identity was verified before activation; the normal durable release journey
passed login, reads, logout, revocation and readiness. All31assets were retained.
Thirteen existing-session/profile/feed/denied-cookie/readiness samples were
healthy from13:26:13.476 through13:26:38.304UTC, maximum start gap2003.788ms.
Baseline completed before dispatch, candidate-phase samples were retained, and
two samples began after command completion. Exact fixture cleanup0, provider
reconciliation and lease release passed; staging remained unchanged.
[Evidence](evidence/logout-prejournal-production-verified-2026-10-29.json).

The earlier rejected operation remains preserved; its unknown login was never
replayed. This fresh release used corrected verification configuration and the
tested preflight gate. Production writer/cleanup remain disabled. This adds
sampled backend code continuity, not frontend/native/schema overlap or the
monthly SLO. The earlier logout latency cause remains an investigation.

## Hosted frontend asset transition — October 29, 16:27–16:30 UTC

[Evidence](evidence/group-invitation-asset-continuity-staging-2026-10-29.json)
records two separate staging activations. The rollback-ready version retained
the old UI and added the candidate immutable assets. It passed 13 continuity
samples with zero failures, two post-command samples, and a maximum sample-start
gap of 2,004.24 ms. A real browser tab stayed open across that activation,
retained its form state and loaded its old cold module with the expected hash
and MIME type; a separate fresh context rendered the retained UI. The browser
HTML comparison removes only the observed external Cloudflare analytics element
at the closing body before requiring exact canonical bytes. Public asset
verification itself remains byte-exact.

The subsequent feature frontend activation completed, but its continuity
acceptance **failed**. At 16:29:16.819 UTC, while the durable controller was still
`prepared`, protected readiness failed with `transport_or_response` and no HTTP
status. Authorized profile/feed reads and denied-cookie rejection passed in that
sample. The controller later completed its own verification and finalized the
new staging version. The observer retained the failure and threw
`CONTINUITY_SAMPLES_FAILED`; it did not collect the post-activation browser check.
This is not a successful zero-failure feature rollout. The failure cause is
unproven, and no deployment or logout mutation was replayed.

This exposes a remaining integration gap: in-command unhealthy observations
currently reject acceptance after the command finishes, but do not themselves
interlock provider dispatch or request compatible rollback. A failure observed
while preparation is still running must prevent subsequent candidate dispatch;
after dispatch, recovery must use the existing durable operation and verified
rollback target. Do not implement this by blindly restarting a deployment or
using a fresh operation ID to hide the failed attempt. Post-terminal failures
also need explicit disposition rather than rewriting successful journal history.

The candidate remains active only in staging, with the verified rollback-ready
version retained. Read-only reconciliation and exact fixture cleanup completed;
zero synthetic rows remain, canonical/provider state agrees, and the shared lease
is released. Production is unchanged. Signed-in feature UI, supported native
clients, production continuity and the remaining reliability gates remain open.

## Continuity stop/rollback gate — local integration verification

The maintained entry point now persists unhealthy samples and checks that gate
through preparation, provider dispatch, candidate verification and finalization.
Integration tests exercise the real local deployment lease, journal, finalization
and observed entry point with simulated provider/network/database ports. They
cover a failure during preparation (zero provider writes), during candidate
verification (one activation plus one compatible rollback), an unhealthy rollback
(retained unresolved state), and a post-terminal failure (durable owner attention,
no history rewrite or replay). Lower-level tests also cover lost activation
acknowledgement, the intent/dispatch boundary, failure during the last provider
read, malformed gate evidence, and process-style reconstruction of the gate.

These are local tests of the production tooling path. The hosted rehearsal above
used the previous tooling and remains failed. A new bounded staging drill and
installation of the updated release-watch bundle remain necessary before claiming
hosted automatic recovery or effective late-failure alert delivery.
