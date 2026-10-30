# Requests spanning a staging rollback

`scripts/release-inflight-probe.ts` supplies a staging-only decorator for the
reviewed deployment controller's ports. The maintained
`executeStagingApiRecoveryDrill` accepts it as the optional sixth argument
(after an omitted candidate action). The activation entry point applies it
inside the existing lease and reviewed provider ports, then requires its durable
proof before finalization. It remains unverified against hosted requests. The
existing candidate-action hook waits for completion before rollback and cannot
establish this stronger overlap requirement.

After the controller authorizes rollback and writes its durable rollback intent,
the decorator exclusively persists a probe intent, then invokes `start` before
forwarding that one deployment POST. `start` must dispatch one owned request and
independently confirm it is still executing. A client-side unresolved promise
alone is insufficient evidence that a Worker is still processing the request.

Only a provider observation of the exact baseline and rollback operation permits
`finish`. That callback must release the owned barrier, verify the original
request outcome and retain its timing evidence. Successful completion is required
before the observation returns to the controller and normal rollback journeys
can run. Candidate observations, unrelated deployments and malformed identities
cannot trigger it. Subsequent observations must retain the same deployment ID.

This decorator retains the controller's ten-second dispatch and five-second
observation deadlines, including callback time. It cannot extend the request's
ten-second budget. A hosted test must prove that the request was executing before
dispatch and remained in flight until after restoration, then independently
verify its durable effects. Callback labels alone do not prove those facts.

The caller must hold the normal lease and verify the exact staging scope,
fixture ownership, unchanged frontend and compatible rollback resources. Its
outer `finally` must release any owned database barrier even if the provider
never confirms rollback or the request times out. Process loss also requires
database connection teardown and independently bounded lock lifetimes. Never hold a global lock
or another member's lock. Capture all outcomes without retrying a mutation.

Lost deployment replies remain subject to the controller's read-only
reconciliation. Existing probe intents prevent constructing another probe for
that operation; unknown callback results cannot finalize rollback. Generic
activation resumption also refuses incomplete probe evidence. Finalization
requires the proof's restored deployment ID to match the terminal journal.
Production, frontend/monitor targets, changed public assets and combining the
candidate-action and in-flight hooks are rejected. Preserve
the original evidence and reconcile separately rather than rerunning callbacks
or changing operation IDs. The helper never authorizes versions, clears journal
state, manufactures mutation proof, or dispatches outside the controller.

Tests use the real recovery state machine with simulated provider ports. They
cover exact transition ordering, lost replies, persistence failures, cancellation,
scope changes, malformed or unrelated deployments, incomplete propagation,
callback deadlines and no replay. These tests do not establish hosted latency,
Worker lifetime behavior or monthly availability.
