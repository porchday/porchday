# Deployment recovery

The recovery controller in `scripts/deployment-recovery.ts` handles a known
failure from the October 28 reader rollout: Cloudflare acknowledged activation,
then a provider GET returned HTTP 500 / code 10500. Repeating the activation was
unnecessary. Read-only reconciliation confirmed the intended version and the
user journeys passed.

This controller is **not yet the live deployment entry point**. The Cloudflare
transport, private filesystem journal and deployment lease are implemented and
tested. Integration with artifact/schema evidence and synthetic journeys, plus a hosted
staging rollback drill, remain required
before unattended use. Unit tests do not establish that production can recover automatically.

## Inputs and safety boundaries

Create a fresh operation UUID and immutable plan containing the Worker name,
candidate version and source commit, baseline version and deployment ID, digest
of reviewed release evidence, and the explicitly verified compatible rollback
versions. A source branch name or a version's age is not compatibility evidence.
The plan digest is only an identity check; it does not authenticate its contents.

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

## Required hosted drill

After the current deployment lease is free, pin the latest canonical state and
confirm that both candidate and rollback artifacts preserve denial readers.
Exercise a reversible staging configuration failure with synthetic checks,
observe automatic rollback, and verify the restored version and journeys. Keep
production free of deliberate destructive tests. Record elapsed detection and
recovery time, known and unknown outcomes, actual provider versions, retained
schema, and alert delivery in the existing reliability issues. Only then wire
this controller into the normal deployment entry point. No new paid service or
production mutation is performed by importing these modules or running tests.
