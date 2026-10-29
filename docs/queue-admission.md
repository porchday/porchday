# Queue inventory and durable admission

This tooling integrates the queue work from PR #90 onto release-tooling baseline
`f92bc4a6a0d8b107b611842c66671b5e6549c5a9`. It preserves the pinned upload-target
restrictions, activation controller, review gates and expanded activation tests.
It does not deploy the isolated cleanup runtime or create provider resources.

## Inventory

`CloudflareReleaseReader` accepts explicit ordinary, fixed denial-range and
dead-letter queue identities. Queue IDs must be distinct and names must match
their environment and fixed range. Active and latest queue bindings must refer
to registered identities. Truncated producer or consumer arrays fail closed.
The standalone reader accepts an optional second argument naming an absolute,
private registry JSON file; old two-queue manifests remain valid.

`queueCatalogue()` reads every reported account page with bounded requests and
rejects duplicate identities, changing totals, incomplete pages and incomplete
consumer/producer lists. Catalogue reads are not atomic; compare catalogue state
around the scoped snapshot. Do not infer absence from a failed or partial read.

## Single-operation settings changes

`QueueAdmissionLease` uses the same SQLite kernel lock and persistent deployment
marker as uploads and activations. A settings plan commits to exact before/after
inventory, request bytes and canonical bytes. Intent is durable before the only
provider send. Unknown replies require read-only reconciliation under that same
operation. Finalization changes only the canonical snapshot reference and saves
a receipt before atomic replacement. Never resend an uncertain request.

## Creation with an assigned ID

A creation plan adds `creation: {key, baselineSnapshotSha256}` and uses the
distinct `porchday-queue-creation-v1` owner protocol. The key must identify one
fixed denial range in the worker's environment. The expected snapshot contains
exactly that new queue, with no producers or consumers, delay zero, retention
345,600 seconds and a false or omitted optional pause field. Only its
provider-assigned ID is unknown before dispatch.
The placeholder used to calculate the planned hash is never written as provider
evidence. Reconciliation records the actual ID; subsequent reads must match it.

The documented create request does not expose pause configuration. Create only
the unattached queue, reconcile it, then pause it in a separate verified settings
operation before attaching a consumer. The first hosted creation returned no
`delivery_paused` property, matching the representation of existing unattached
dead-letter queues. Reconciliation accepts that omission only in the otherwise
exact unattached shape and retains the raw omission in provider proof. It does
not assert that the provider explicitly returned false. Explicit true, null,
strings, unexpected settings or attached execution are still rejected.
Other unexpected defaults require investigation, not a repeated create.
A missing queue after a timeout
also does not permit resending the create request.

## Operator workflow requirements

Before dispatch, verify exact-source tooling CI, a clean tooling checkout, fresh
independent production probes, canonical bytes, complete account catalogue and
the scoped provider snapshot. The new queue name must be absent from the entire
catalogue. Bind those evidence hashes and exact request bytes into the manifest.

After dispatch, read the full catalogue, find exactly one matching queue, read
its exact ID through an expanded registry, and read the catalogue again. Require
the old catalogue to be unchanged except for that one unattached addition and
the two post-create catalogue reads to agree. Persist private evidence before
reconciling the lease. Finalization needs another matching provider observation.
After a crash, resume the original manifest and intent; never invent a new ID.

Creation does not authorize attachment or delivery. Before isolated runtime
activation, separately verify all producer bindings, one consumer per fixed
range, an ordinary-queue cap of one, batch size one, retries, dead-letter routing,
rollback compatibility and aggregate database headroom. Four queue invocations
are not a four-connection bound. The 10,000-live/400-denied workload still needs
to pass from idle under unchanged freshness limits. Tracks #9 and #42.

The first staging creation succeeded, but its original strict comparison stopped
before finalization because of the omitted pause field. The original intent and
manifest are preserved. Recovery must use read-only catalogue/detail evidence
under that same operation; it must never repeat the POST. No consumers or
producers were attached, and existing provider inventory is checked independently.
