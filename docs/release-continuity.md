# Existing-session observation during releases

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
