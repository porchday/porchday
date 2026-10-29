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
