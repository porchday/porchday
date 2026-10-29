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
late responses, retention failures, scope loss and credential redaction. Hosted
integration is still pending. It does not yet prove a normal feature deployment,
browser/native client overlap, backward-compatible schema changes or production
continuity. Those remain acceptance criteria in issue #3.
