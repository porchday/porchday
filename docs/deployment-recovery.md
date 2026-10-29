# Deployment recovery

The recovery controller in `scripts/deployment-recovery.ts` handles a known
failure from the October 28 reader rollout: Cloudflare acknowledged activation,
then a provider GET returned HTTP 500 / code 10500. Repeating the activation was
unnecessary. Read-only reconciliation confirmed the intended version and the
user journeys passed.

This controller is **not yet the live deployment entry point**. The Cloudflare
transport, private filesystem journal and deployment lease are implemented and
tested. A hosted staging drill verified automatic rollback with real artifact,
schema and journey checks; finalization required an operator-assisted correction
of inactive-version settings. Move those adapters into the reviewed normal release
entry point and verify unattended finalization before unattended use. The drill
does not establish automatic production recovery for every failure mode.

## Inputs and safety boundaries

Create a fresh operation UUID and immutable plan containing the Worker name,
candidate version and source commit, baseline version and deployment ID, digest
of reviewed release evidence, and the explicitly verified compatible rollback
versions. A source branch name or a version's age is not compatibility evidence.
The plan digest is only an identity check; it does not authenticate its contents.

The target can be `porchday-staging`, `porchday-production`, or the corresponding
`-edge` frontend Worker. Staging currently routes public traffic through its
frontend; production currently routes directly to its API Worker. Select the
actual serving component from the verified topology. A backend-only staging
activation does not publish a changed frontend asset package.

Frontend plans additionally require `backendVersion` and `backendReaderFloor`.
The lease requires the frontend to be enabled in the canonical topology and those
backend pins to match. Frontend rollback targets belong in
`compatibleRollbackVersions`; backend privacy compatibility is acknowledged
separately. Finalization updates the frontend code version/source under
`edgeRouting`, preserves backend and asset provenance, and checks that a supplied
snapshot still has the pinned backend version. It records recovery under the
component key such as `staging-edge`. Existing API plan hashes and finalization
receipts retain their format; the completed October 28 hosted drill remains
readable with these changes.

`authorize` must verify the exclusive deployment lease, canonical deployment
record, actual artifact/source provenance, schema compatibility, bindings,
assets, routes, queue policy and current denial-reader floor. It runs before
activation and again before rollback. All deployment writers must honor the
same lease. Provider observation alone cannot eliminate a race with an
uncooperative external operator because the deployment API has no conditional
compare-and-swap in this integration.

Once denial records can exist, never roll back to an API that ignores them.
Turning off new writers does not make old readers compatible. The initial reader
rollout records a minimum version in each environment; it does not establish an
alternate tested rollback target. Additive database migrations remain in place
when application versions roll back.

`verify` must check required user journeys and deployed assets against the
expected version. A shallow health response is insufficient. Return `unhealthy`
for a confirmed candidate failure, `healthy` only after the required checks pass,
and `unknown` when the evidence cannot support either conclusion. Honor the
abort signal. Never replay an ambiguous user mutation when repeating a probe.
The controller does not repair database state, clear privacy intents, or infer
that rollback reverses a migration.

## Shared journey and asset verifier

`createReleaseVerifier` in `scripts/release-verification.ts` supplies the controller's
`verify` port. Provide the immutable plan, a dedicated synthetic-account config,
the candidate and baseline public-asset manifests, and an absolute private
evidence directory. Never reuse the continuous production monitor's identity
concurrently. The factory snapshots inputs, checks the environment and manifests,
and refuses overlapping calls. The authorization adapter must still authenticate
the manifests and their source/CI provenance against the plan's release evidence.
Code and asset source commits can legitimately differ, particularly for the
retained staging frontend executable.

Each invocation records a durable start before making requests, performs one
authenticated journey, and records its sanitized observation. A completed failed
journey, including a request timeout or transport failure, is `unhealthy`; it is
an observed availability failure without claiming a root cause. This can cause a
conservative rollback during a local network problem. The controller must still
observe its exact deployment and reauthorize a compatible rollback target.
Cancellation of the enclosing verification is `unknown`; unexpected exceptions
or evidence-write failures also remain unavailable to the controller.

After a successful journey, the verifier checks the expected public assets. It
allows up to three read-only convergence rounds, spaced by 250 and 750 milliseconds,
and saves every round, including failures. It never repeats the login/logout
journey just to retry assets. Persistent incorrect bytes, MIME types, statuses or
transport failures are `unhealthy`. Only a passing journey and complete matching
asset report can return `healthy`. The controller's overall deadline still applies.

Integration tests use the actual controller and durable journal to demonstrate
that persistent HTTP-200 HTML for an expected module triggers one rollback and
that the restored version is verified against its own manifest. These are local
fixtures, not a hosted release of this new adapter. Provider/source/schema
authorization, inactive uploads, asset-aware canonical finalization and a complete
normal release command remain required. In particular, the current lease's
code-version finalization must not be used to claim new asset provenance.

## Durable operation and resumption

Use a dedicated private directory and `FileRecoveryJournal` for each operation.
Every transition is an exclusive append followed by file and directory fsync.
An intent must be durably recorded before its deployment POST. A concurrent
append, altered plan, missing revision, malformed record or torn write stops the
controller. Do not delete or reset a journal to get past such a stop.

Resume with the same plan and journal. Existing activation and rollback intents
are observed, **never sent again**. Even an intent written just before process
loss is ambiguous: the next process cannot know whether the POST was sent.

The Cloudflare adapter tags each deployment with the operation UUID. It requires
one version at 100% and rejects percentage rollouts. Reconciliation checks the
version, deployment ID and operation marker; another operator deploying even the
same candidate is not silently treated as this operation's success.

Safe provider reads have at most three five-second attempts, with 250ms and
750ms delays. HTTP 408, 429, 500, 502, 503 and 504 and transport failures are
retryable reads. Authorization, malformed state and unsupported rollout shapes
are not. Deployment POSTs have a ten-second observation deadline and are never
retried. Lease/evidence checks have ten-second deadlines; journey verification
has a 45-second deadline. Adapters must honor cancellation; a timed-out write
can still commit and must be reconciled.

## Exclusive deployment lease

`FileDeploymentLease` requires POSIX filesystem semantics and Node 24 with the
built-in experimental `node:sqlite` module. Its SQLite transaction provides a
kernel-released mutex, while `deployment-lock/owner.json` preserves the existing
rollout coordination convention. Every writer must honor that directory lock.
The canonical record and lock directory must be private and owned by the operator.

A live controller excludes a second controller. After process loss, the same
immutable plan can resume; a different operation or legacy rollout marker is
never taken over based on elapsed time or a PID. Closing the lease releases only
the kernel mutex and retains the persistent marker. Releasing the marker requires
a matching terminal journal and completed canonical record finalization. It
atomically renames the intact lock directory into an operation-specific archive,
so interruption cannot leave an empty lock directory.

`leasedDeploymentPorts` checks the lease and unchanged canonical record at the
provider I/O boundary, requires a matching durable intent before a write, and
rejects a repeated dispatch within the process. The supplied authorization
callback must still verify actual artifact/schema evidence. A recorded reader
floor is an acknowledgment requirement, not proof of artifact compatibility.

Tests kill isolated child controllers and demonstrate same-plan resumption after
both lock acquisition and a simulated provider commit. The latter resumes from
the durable activation intent without another POST. These are local fixtures,
not hosted recovery evidence.

After the controller verifies a terminal outcome, capture and validate the full
provider snapshot, then call `finalize(journal, snapshotPath)` and
then `release(journal)`. Finalization saves a durable receipt containing the exact
before/after canonical bytes and terminal journal state before replacing the
canonical record. Only the targeted API version/source and its deployment recovery
receipt change; schema, assets, routes and other deployment evidence are retained.
The snapshot path also updates `latestProviderSnapshot`; its bytes are hashed into
the finalization receipt and must identify the terminal API version. The caller
must verify the snapshot against the provider and release contract first; a local
JSON file alone is not provider evidence. Omitting the snapshot is supported for
local fixtures, but a hosted rollout must supply it.
This is suitable for API-version-only operations. Changes to other resources need
a separate reviewed finalization contract.

A restart during finalization may reacquire the same plan when the canonical bytes
match either side of its receipt. Such a lease prohibits provider I/O: resume
`finalize` and `release` only. Any other canonical bytes or altered receipt stop
recovery. Tests kill real child processes before replacement, after replacement,
and after lock archival. After archival, `completed` reads the historical receipt
and checks it against the journal; it does not assert current provider health.
An archived operation ID cannot start another deployment.

## Outcomes and operator action

- `complete`: candidate checks passed and the exact deployment was observed.
- `rolled-back`: a compatible baseline was restored and its checks passed.
- `activation-unconfirmed` / `rollback-unconfirmed`: the intended transition is
  not yet observed. Keep monitoring, resume reads with the same journal, and
  escalate if it persists. Do not submit another deployment POST.
- `observation-unavailable` / `verification-unavailable`: preserve the journal
  and inspect independent observations. Neither outcome is proof of recovery.
- `concurrent-change`: stop changing the provider and reconcile the other
  operator's deployment and lease.

A terminal journal is historical evidence, not a perpetual health guarantee.
Independent monitoring and actionable owner alerts must remain active. Persistent
control-plane failure can prevent rollback even if a candidate is unhealthy;
this controller is not cross-provider failover and cannot guarantee 99.99%.

## Hosted staging drill and remaining gates

On October 28, controller source `b424808` ran against the real staging Worker.
The candidate retained application source `52949ef0`, all 24 assets, the denial
readers and the 56-migration schema. Only `APP_URL` changed to a reserved `.invalid`
hostname. The candidate's synthetic sign-in returned 403, while shallow checks
still passed. The controller detected the failed journey and automatically restored
the verified baseline with one rollback POST.

Activation dispatch to verified rollback took **7.546 seconds**. The restored
journey, asset hashes and exact provider deployment identity passed, followed by
two more complete journeys. Production's concurrent external cycles stayed healthy.
This is evidence for this staging configuration fault, not a continuous outage
duration measurement or a guarantee for every failure mode.

The full post-rollback snapshot exposed a separate provider behavior: active-version
resources had the correct configuration, but Worker-level settings still described
the latest uploaded, inactive candidate. Finalization stopped rather than accepting
that mismatch. An explicitly recorded corrective **inactive upload** restored the
safe settings without another activation. Its code and resources were verified,
an additional journey passed, the synthetic fixture was removed, the final snapshot
was pinned in the canonical record and the lease was archived. All 24 public assets
were checked again after correction. This operator-assisted completion is not yet
unattended release automation.

The existing GitHub bot relay delivered explicitly marked outage and recovery drill
comments; both exact comments were read back. Human/device receipt remains a separate
check. See [sanitized drill evidence](evidence/deployment-recovery-2026-10-28.json).

Before enabling the normal deployment entry point:

- Move the actual artifact/schema/resource and journey adapters into reviewed
  repository tooling, including safe handling of active versus latest-uploaded
  configuration. Never let a later release inherit an inactive failed candidate.
- Verify normal daily feature deployment continuity with authenticated traffic
  running before, during and after activation. A successful rollback drill does
  not prove that an ordinary feature rollout has no downtime.
- Preserve old/new API and client compatibility, immutable assets needed by open
  clients, additive migrations and the denial-reader floor. Separate risky feature
  activation from code deployment where appropriate.
- Exercise interruption/resumption and failed finalization through that same
  normal entry point, retain failed evidence, and keep owner alerts independent.

These daily-release requirements are tracked in [#3](https://github.com/porchday/porchday/issues/3)
and the complete availability objective remains in [#42](https://github.com/porchday/porchday/issues/42).
Persistent provider control-plane failure and cross-provider failover remain
separate limitations. No deliberate production outage was induced by the drill.
