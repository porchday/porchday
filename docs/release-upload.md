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
