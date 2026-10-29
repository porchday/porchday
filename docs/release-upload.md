# Inactive version upload safety

`scripts/release-wrangler.ts` prepares and verifies the reviewed Wrangler 4.152.0
CLI for inactive version uploads. It pins the lockfile package version, npm URL,
integrity, installed package version and the complete original CLI SHA-256. It
removes exactly the version-creation `retryOnAPIFailure` wrapper, leaving the
request body, strict binding inheritance and other code unchanged. Content-addressed
asset upload retries remain enabled. The original CLI file is never overwritten.

Call `prepareReleaseWrangler(absoluteWorkspace)` during release preparation and
save its receipt in private release evidence. It writes a hash-named, owner-only
copy beside the original CLI so its module resolution remains intact. Repeated
preparation accepts only identical bytes. A partial file left by interruption
fails verification; preparation does not overwrite it. Call
`verifyReleaseWrangler(workspace, receipt)` immediately before dispatch to recheck
the package, lockfile and patched bytes. Dependency upgrades require a reviewed
new pin and patch; they do not silently fall back to the stock CLI.

These functions perform local file operations only. They neither upload nor
activate a Worker, and the receipt does not authorize a release. The upload
orchestrator must still hold the shared release lease, validate exact source/CI,
configuration, schema and assets, and persist an exclusive durable upload intent
before spawning the verified CLI. Never rerun the command after a timeout,
process interruption, provider error or lost response. Reconcile using read-only
provider observations and the operation annotation. Ambiguity remains unresolved
until the uploaded version and complete resources/artifacts are identified.
An inactive upload must not be treated as successful activation.

The tests use the actual pinned installed CLI: they validate the prepared copy's
syntax, execute the patched version-request expression with synthetic transports,
verify one invocation on success and ambiguous errors, and reject changed package
metadata, bytes, receipts, permissions and symlink substitutions. No provider
write is made by these tests. This does not yet prove the complete normal upload
and recovery workflow; durable dispatch and release orchestration remain separate
integration requirements.

## Durable dispatch and locking

`FileUploadLease` in `scripts/release-upload-lease.ts` uses the same SQLite kernel
lock and persistent `deployment-lock` marker as `FileDeploymentLease`. Its plan
exists before Cloudflare assigns the candidate version ID: it pins the operation,
Worker, source, canonical bytes and reviewed preparation evidence digest. A
competing upload or activation cannot acquire this lock. Closing or process death
releases the kernel lock while retaining the marker for only the same plan.

`dispatchOnce` checks the lease, awaits the caller's full release authorization,
rechecks the lease and durably writes an exclusive intent before invoking the
single-attempt transport. An existing intent returns `reconcile` without invoking
either authorization or transport. This applies even when a crash happened before
the request reached Cloudflare; absence of a response is never permission to retry.
Transport failure or cancellation after dispatch also returns `reconcile`.
`dispatched` means only that the transport returned, not that an upload is verified.
All asynchronous callbacks must honor their supplied signal and manage any child
process to completion; the lease cannot be closed while a callback is in flight.

`reconcile` is a read-only callback contract. The caller must identify the exact
version by operation annotation, verify its code/assets/settings against reviewed
evidence, and confirm all active routing and unrelated resources are unchanged.
Persist that private verification evidence before returning its SHA-256 and the
version ID. This library records the returned digest; it does not independently
perform those provider/artifact checks or authenticate the callback's assertion.
Failed reconciliation retains the unresolved marker. Repeated reconciliation must
agree with the saved version and digest.

After verification, `release` archives the intact marker and receipts atomically.
`completed` reads that historical receipt after interruption at archive. Canonical
active state is not modified by an inactive upload. The activation workflow must
acquire its own lease and revalidate current state against the verified post-upload
inventory, not assume exclusivity continued between upload and activation. It
must pin the uploaded version and its evidence into the deployment plan.

Tests cover contention in both directions with the existing deployment lease,
ambiguous response/resume, failed authorization, cancellation, failed reconciliation,
changed plans/canonical bytes, partial records, concurrent calls, historical receipt
readback and a real SIGKILL after dispatch. The October 29 auth-rollback release exercised this composition through the
maintained upload CLI on staging and production; see the hosted evidence below.

## Concrete subprocess transport

`createWranglerUploadProcess` in `scripts/release-upload-process.ts` supplies the
transport callback for `dispatchOnce`. It snapshots its inputs, rechecks the private
config's SHA-256 and target/account, verifies the pinned CLI receipt and spawns
`versions upload` without a shell. It supplies the operation UUID as the upload
message for later provider reconciliation. It refuses build hooks, alternate
environments, container/export configuration, bundling and enabled preview URLs.
The transport now requires a `ReleaseUploadInputs` manifest and rechecks the complete
private executable, source-map and asset directories before starting Wrangler.
Config paths must match those manifest roots. Extra, missing or changed files,
symlinks, public permissions and additional module discovery fail before spawn.
The check bounds directory depth, file count and byte volume. Source/CI authorization
must still bind these manifests into the release plan; hashes alone do not prove
build provenance. The release owner must prevent concurrent edits while Wrangler
reads the files; this preflight does not provide a filesystem snapshot or prove
hosted asset publication.

The child receives an explicit environment containing only the required provider
credentials, PATH/HOME/TMPDIR, CI/output controls and a private Wrangler log directory.
It does not inherit NODE_OPTIONS or other arbitrary parent variables. A pinned
preload guard sets a private umask and monitors a dedicated inherited control pipe. This
prevents a killed controller leaving the uploader running indefinitely. It cannot
undo a request that reached the provider; the durable intent still requires
reconciliation. The control pipe and IPC channel are unreferenced so normal CLI exit is not delayed. Wrangler intentionally disconnects IPC in its finally block; that cleanup must not be mistaken for controller death. Closing the separate control pipe still terminates the uploader after controller death, including after normal IPC cleanup.

Execution has a four-minute deadline and a one-MiB combined stdout/stderr cap.
Cancellation, timeout or excessive output sends SIGTERM, then SIGKILL after one
second if needed. The callback waits for the child's close event before returning,
so the upload lease remains in flight through termination. Failed execution reports
a fixed error code, without returning raw diagnostics or credentials. Wrangler's
own logs remain in the owner-only directory with sanitization enabled. Successful
stdout can yield an untrusted version hint, but the upload callback discards it:
provider/artifact reconciliation is mandatory even after exit code zero.

Subprocess tests cover normal exit, nonzero exit, output overflow, timeout/SIGKILL,
cancellation, normal IPC cleanup and real controller SIGKILL followed by uploader exit both before and after IPC cleanup. Configuration
tests reject target/hash drift and unreviewed execution settings before spawn.
These tests use synthetic child programs and make no provider writes. The maintained upload command integrates source/CI authorization and provider
reconciliation and has exercised this transport on hosted candidates.

## Read-only upload discovery and inventory isolation

`CloudflareReleaseReader.uploadedVersion` searches the provider's returned recent
version list for exactly one `porchday-upload:<operation UUID>` annotation. It
then fetches that version and requires its ID and annotation to agree with the
list. Missing or multiple matches fail unresolved. Discovery is bounded to the
returned list (at most 100 entries); it does not paginate indefinitely or infer
identity from whichever version happens to be latest. An old operation falling
outside the returned list requires further read-only investigation, never another
upload. Calls retain the reader's GET-only transport, concurrency, retry, deadline
and body-size limits.

`assertInactiveUploadSnapshot` compares complete before/after inventories with
deterministic object-key ordering. Only the selected Worker's latest version and
exact reviewed settings may change. The candidate must differ from the previous
active and latest IDs. All active resources, other Workers, domains, queues and
schedules must stay identical. Pass reviewed settings from preparation evidence;
do not copy the post-upload settings to manufacture an expected result. Baseline
provenance and freshness still require the release lease and authorizer.

This check passed the saved before/after inventories from the October 28 staging
rollback drill with its explicitly reviewed APP_URL change. A live GET-only
negative check on October 29 returned unresolved for an absent operation. Neither
check performed an upload or activation. Matching annotations and resource isolation
do not verify executable/source-map bytes or uploaded asset content. Those checks
remain required before writing a reconciled upload receipt and activating it.

## Executable and source-map comparison

`CloudflareReleaseReader.script` downloads multipart Worker modules through the
same GET-only transport, bounded to 16 MiB total and 16 file parts. It rejects
duplicate module names, unexpected text fields, unsafe names and malformed responses. The provider’s observed JavaScript text field (`index.js` or `edge.js`) is decoded as UTF-8 and still subjected to exact executable byte comparison.
The script endpoint is not version-addressed: identity and full inventory checks
must surround the read under the release lease. A module download by itself must
never be attributed to an arbitrary version ID.

`verifyWorkerArtifacts` requires exactly `index.js`/`index.js.map` or
`edge.js`/`edge.js.map`, checks the prepared files against their reviewed SHA-256
pins, and requires byte-identical executable content. Source maps must also be
byte-identical unless the caller explicitly allows the previously observed
provider normalization: removal of `sourceRoot`, addition of empty `file` and null
`sourcesRoot`, and replacement of exactly the four known missing proxy dependency
sources with empty strings. All other fields, source paths/content, symbol names
and mappings must match exactly. This does not grant permission to omit application
sources or ignore arbitrary source-map differences.

The comparison passed saved actual API artifacts from the October 28 drill against
the reviewed feature release bundle: executable bytes matched and the 1,029-source
map matched the observed normalization. A later live staging frontend read on
October 29 also passed after identifying a second exact provider transformation:
leading `../` segments are removed from each source path and `file` is the entry
filename. This requires the separate `allowObservedPathNormalization` opt-in in
addition to the original normalization opt-in. Every remaining map field, all
source content and all relative source-path suffixes must still match; arbitrary
path changes remain rejected. This is a narrow comparison of observed formats,
not permission to normalize arbitrary differences.

The live read verified version `913d617a-f7f9-40fd-92b7-8efe3e649fa9`, with unchanged
full inventories before/after and unchanged canonical bytes. Initial parser and
map-format rejections were investigated before enabling the exact transformations.
No upload, activation or database write occurred. Static-asset publication and
continuous authenticated rollout acceptance remain separate requirements.

## First-party source provenance

`verifyWorkerSourceProvenance` checks every first-party source embedded in the map
against immutable Git blobs at an explicit full commit SHA. The caller supplies
the complete reviewed path set, not a minimum file count. Extra, missing, duplicate,
unsafe or content-mismatched application paths fail. API/monitor sources and shared
crypto sources are included. Reads are bounded, cancellable `git show` calls and do
not use modified working-tree files. The result records individual source hashes
and a digest of the complete source manifest.

The live staging frontend map matched all 37 reviewed first-party files at
`005454607c98ffdb7c430a947bedb4586a14a45b` and preserved the full 1,020-source map
under the explicit provider transformation. Tests use a temporary real Git repository
to verify immutable-commit behavior despite worktree edits, and reject omitted,
duplicate, changed or unsafe sources. This verifies embedded source content; it
does not prove by itself that arbitrary executable bytes were compiled from that
content. The prepared executable/hash manifest still requires trusted build and
exact-source CI authorization.

## Prepared upload orchestration

`createPreparedUpload` and `runPreparedUpload` in `scripts/release-upload.ts`
compose authorization, transport and reconciliation from one cloned evidence
object. `PreparedUploadEvidence` requires preparation containing the exact config
hash/path, Wrangler receipt, bundle/asset manifests, tooling commit and reviewed
CI pins for tooling and asset sources. The existing upload-plan digest covers
this whole object. Its bundle must equal the bundle used for provider reconciliation.

Before intent, authorization checks the clean tooling checkout and exact-source
CI, prepared files, runtime CI, schema, embedded first-party source and full provider
baseline. Tooling must be at the pinned HEAD with no tracked/untracked changes or
skip-worktree/assume-unchanged index flags. The transport independently rechecks
config, CLI and complete local inputs. Reconciliation repeats preparation checks
and records their results alongside provider, runtime artifact and schema evidence.
Historical reconciliation evidence without preparation remains readable; the new
orchestration entry point requires it.

Every dispatch outcome proceeds through reconciliation. An uncertain upload with
failed reconciliation retains its lease marker; resuming the same operation does
not authorize or send again. Successful reconciliation archives the inactive-upload
receipt without changing active canonical state. No activation is performed.
The operator CLI below invokes this maintained entry point. A hosted rollout has passed using a private activation adapter around the
maintained deployment controller. The general activation command remains unfinished. Failed authorization before intent
leaves the same-plan marker, which can be explicitly cancelled through the owned
lease only when no upload intent exists; never remove it by age.

Tests exercise the orchestration with a real durable lease and synthetic external
gates: failed preparation/CI/schema/baseline gates send nothing; uncertain dispatch
resumes through reconciliation only. Separate tests exercise real Git tooling
checks, changed config after CI, required asset source pins and bundle mismatch.
These are not hosted provider tests. Source/CI pins and hashes require reviewed
build provenance; passing CI does not independently prove that asset bytes were
built from the claimed source. Concurrent local mutation remains outside the
filesystem preflight guarantee.

## Operator command

Prepare a private absolute-path JSON manifest matching `UploadManifest` in
`scripts/release-upload-cli.ts`. It contains the version (1), shared private root,
clean tooling workspace, private proof/log directories, upload plan, complete
prepared evidence and reviewed staging/production queue IDs/names. Credentials
are supplied only through the environment, not the manifest. The plan digest must
match the evidence and its canonical digest must match the shared current state.
The workspace must be the checkout executing the command.

Run the inactive upload (or resume the exact same operation):

```sh
python3 scripts/with-secrets.py node scripts/release-upload-cli.ts upload /absolute/private/upload-manifest.json
```

The command uses `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and the target's
`PORCHDAY_STAGING_DATABASE_MIGRATION_URL` or
`PORCHDAY_PRODUCTION_DATABASE_MIGRATION_URL`. Database target and reader configuration
are checked before lease acquisition. SIGINT/SIGTERM cancel bounded work; a
15-minute outer deadline also applies. Failure prints a fixed message, leaves
private evidence intact and never automatically assigns another operation ID.
A completed archived receipt returns `already-verified` without credentials,
provider reads or writes. Successful new work returns `verified-inactive`, never
an assertion that the version is active or that its public assets are healthy.

To abandon a failed preparation that has **no durable upload intent**:

```sh
node scripts/release-upload-cli.ts cancel /absolute/private/upload-manifest.json
```

This acquires the exact owned plan, verifies canonical state and archives its
owner-only record as `release-upload-cancelled-<operationId>`. The cancelled ID
cannot be reused. Any intent, partial intent, in-flight callback or unexpected
marker content prevents cancellation. After a send was attempted, only read-only
reconciliation is permitted. Cancellation never deletes an inactive provider
version. A crash after successful archive is recoverable through the archived
record; do not remove or overwrite it.

CLI tests use real private manifests and lease records, verify cancellation
refusal after uncertain dispatch, credential-free completed-receipt readback,
manifest drift/permissions and sanitized failures from a real child invocation.
They do not exercise a hosted upload. Activation, continuous authenticated checks
and public asset verification remain required after an inactive upload.

## Hosted evidence and activation handoff

The [October 29 auth-rollback rollout](auth-rollback-rollout-2026-10-29.md)
used the maintained upload CLI for staging and production. Both uploads verified
inactive candidate artifacts, source, schema and complete provider inventories
before separate guarded activations. Authenticated journeys, logout revocation
and public assets passed after activation. This is evidence for those releases,
not proof of the monthly availability target or every future release.

`readCompletedUpload` in `scripts/release-activation-evidence.ts` reads the actual
archived upload lease and verifies the owner-only proof against its recorded digest.
It checks the candidate, source, tooling source, schema, executable hash, source
path set, reviewed resources and inactive inventory. It rejects unresolved uploads
and altered evidence. This is historical evidence; it neither acquires a deployment
lease nor authorizes an activation.

`assertActivationInventory` constrains activation and rollback to the pinned
Worker's active version and resources. Unrelated Workers, routing, queues and
schedules remain pinned. Latest-version settings stay at their verified upload
state even during rollback; they are not evidence of the restored runtime's
settings. Frontend plans also pin the active backend. Upload and activation share
the same resource comparison, ignoring binding/property order and provider etags
while preserving binding values and runtime configuration.

The normal activation command must still compose this handoff with a newly acquired
deployment lease, fresh CI/schema/provider authorization, compatibility checks,
single-attempt activation, interruption reconciliation and journey/asset verification.
Do not treat these historical helpers as permission to activate a saved candidate
after another release has changed the baseline.

### Fresh state checks and controller composition

`createActivationStateVerifier` in `scripts/release-activation-state.ts` checks
fresh state under the deployment lease. It pins the baseline source to canonical
state, rereads the archived upload proof, verifies the current clean tooling and
exact-source CI for tooling/candidate/baseline, and compares schema and full
provider inventory. It repeats schema/inventory after CI and settles independent
reads before returning a failure. The activation tooling source may differ from
the upload tooling source; each has its own evidence. Cancellation or failed CI
never authorizes a write. The controller's existing deadline still applies;
hosted timing of this new composition remains to be validated.

`createPreparedActivationPorts` adds these checks to the existing controller and
lease wrapper. A required caller authorizer must bind the complete activation
evidence, including `ActivationStateEvidence`, to the plan's evidence digest and
validate reviewed compatibility evidence. The module intentionally does not infer
semantic compatibility from schema equality or successful CI. Journey verification
is bracketed by fresh schema/inventory checks. A lost deployment reply follows the
controller's observation-only recovery path, and canonical finalization remains a
separate operation requiring a terminal journal and fresh retained proofs.

Local tests compose the real deployment lease with synthetic provider responses:
failed compatibility authorizes no send; a committed activation with a lost reply
is observed without replay; unhealthy candidate verification rolls back once; and
drift during the journey prevents completion. These tests do not constitute a new
hosted rollout or replace client compatibility acceptance. The operator manifest and complete activation CLI remain to be finished.
The reviewed compatibility contract is described below.

### Reviewed compatibility contract

`ActivationReviewEvidence` in `scripts/release-activation-review.ts` binds the
fresh-state evidence, candidate/baseline public asset manifests and a private
compatibility review into the deployment plan's evidence digest. The review names
the exact Worker, candidate and rollback versions/sources, schema fingerprint and
asset hashes. Each required assessment records a rationale and SHA-256-pinned,
owner-only supporting files: schema rollback, denial readers, old web-client
compatibility, supported native clients, retained assets and staging acceptance.
Missing, pending or mismatched assessments fail closed. Files are read without
following symlinks, with bounded size and total evidence volume.

The first staging activation necessarily precedes hosted staging acceptance.
Only its `stagingAcceptance` check may therefore be explicitly `scheduled` with
an explanation and no result files. The verification result reports that pending
check. Production requires completed staging acceptance evidence; other checks
cannot use this exception. This does not make staging acceptance complete or
permit promotion before the result is reviewed.

`createReviewedActivationPorts` supplies the concrete compatibility authorizer to
the state/controller composition. It rechecks review bytes and supporting files
before activation/rollback and around journeys, including resume after an uncertain
write. Callers supply the narrow provider transport and journey verifier, not a
replacement compatibility callback. Finalization is composed below; the operator CLI remains to be integrated.

These checks establish review scope and evidence integrity. An operator must still
inspect the actual test coverage and conclusions: a hash does not authenticate a
test's claims, and a generic passing test log cannot establish client compatibility.
The module does not fabricate acceptance evidence from CI or schema equality.

### Terminal proof collection and interruption-safe finalization

`finalizePreparedActivation` in `scripts/release-activation-finalize.ts` requires a
matching terminal controller journal. It performs no deployment or authenticated
journey. It checks the exact deployment ID and operation annotation, fresh schema
and full provider inventory, and public asset hashes; it repeats state and identity
checks after asset reads. Only then does it durably save provider and asset proofs,
call the lease's canonical finalization, and archive the lease. A failure before
receipt persistence leaves canonical state and the owned lease intact.

A crash after the durable finalization receipt uses `resumeFinalization` to finish
that same receipt and archive locally. The receipt, journal, canonical bytes and
retained proof digests must still agree. This path deliberately returns
`resumed-historical-finalization`: it completes historical bookkeeping without
claiming newly observed health, invoking a user journey, or repeating a provider
request. Callers must check `FileDeploymentLease.completed` before acquiring an
already archived operation. The operator command still needs to wire these paths
together and provide the durable authenticated-journey resume behavior.

Local validation covers successful activation and rollback finalization, failed
assets, changed provider identity/inventory, changed journal/review, and resume
after canonical replacement but before archive without remote calls. Existing
real-process crash tests now exercise the resume method before and after canonical
replacement. No new hosted rollout is claimed by these tests.
