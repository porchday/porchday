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
readback and a real SIGKILL after dispatch. No hosted upload has yet exercised this
new composition. Source/CI authorization, the concrete subprocess transport and
provider/artifact reconciliation still require integration in the normal command.

## Concrete subprocess transport

`createWranglerUploadProcess` in `scripts/release-upload-process.ts` supplies the
transport callback for `dispatchOnce`. It snapshots its inputs, rechecks the private
config's SHA-256 and target/account, verifies the pinned CLI receipt and spawns
`versions upload` without a shell. It supplies the operation UUID as the upload
message for later provider reconciliation. It refuses build hooks, alternate
environments, container/export configuration, bundling and enabled preview URLs.
The caller must still verify every referenced executable, source map and asset
against preparation evidence immediately before dispatch.

The child receives an explicit environment containing only the required provider
credentials, PATH/HOME/TMPDIR, CI/output controls and a private Wrangler log directory.
It does not inherit NODE_OPTIONS or other arbitrary parent variables. A pinned
preload guard sets a private umask and exits on controller IPC disconnect. This
prevents a killed controller leaving the uploader running indefinitely. It cannot
undo a request that reached the provider; the durable intent still requires
reconciliation. The IPC channel is unreferenced so normal CLI exit is not delayed.

Execution has a four-minute deadline and a one-MiB combined stdout/stderr cap.
Cancellation, timeout or excessive output sends SIGTERM, then SIGKILL after one
second if needed. The callback waits for the child's close event before returning,
so the upload lease remains in flight through termination. Failed execution reports
a fixed error code, without returning raw diagnostics or credentials. Wrangler's
own logs remain in the owner-only directory with sanitization enabled. Successful
stdout can yield an untrusted version hint, but the upload callback discards it:
provider/artifact reconciliation is mandatory even after exit code zero.

Subprocess tests cover normal exit, nonzero exit, output overflow, timeout/SIGKILL,
cancellation and real controller SIGKILL followed by uploader exit. Configuration
tests reject target/hash drift and unreviewed execution settings before spawn.
These tests use synthetic child programs and make no provider writes. The complete
normal release command still needs source/CI authorization and concrete provider
reconciliation before this transport can be exercised on a hosted candidate.

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
duplicate module names, non-file parts, unsafe names and malformed responses.
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
map matched the observed normalization. No live read was performed for that proof.
The attempted live staging-frontend validation stopped before provider access
because another release held the shared lock. Live download validation remains
outstanding. Local byte pins still require source/CI provenance authorization;
these comparisons do not independently verify that provenance or static assets.
