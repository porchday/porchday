# Assets across daily releases

A read-only production check on October 29 found that the preceding release's
`assets/index-Bbad13p_.js` and `assets/index-CULjf6me.css` returned HTTP 200 HTML
instead of their published bytes. Current JavaScript and CSS matched their
verified hashes and MIME types. A client requesting an uncached old file could
therefore fail despite an apparently successful HTTP response. Actual affected
member sessions have not been demonstrated. This is tracked in [#3](https://github.com/porchday/porchday/issues/3#issuecomment-6484069069).

`scripts/release-assets.ts` assembles a new public asset directory from reviewed
build manifests. It copies every candidate file and retains prior `assets/`
files and versioned PWA icons. It never copies an old mutable HTML entry point,
service worker, manifest, headers file or unversioned root asset over the candidate.
Shared immutable paths must have identical hashes; a collision stops packaging.
Missing, tampered or symlinked files also stop packaging. Inputs are read without
modification. An existing output directory is never intentionally replaced.

Run with Node 24:

```sh
node scripts/release-assets.ts /private/release/asset-plan.json /private/release/assets
```

The plan has `candidate` and `retained` fields. Each build specifies an absolute
`directory`, a full source commit in `source`, and a `files` object mapping relative
public file paths to SHA-256 hashes. `retained` is an explicit array of supported
previous builds. The command prints the resulting manifest, retained paths,
source identifiers and total size. Save and hash that receipt as release evidence.
The complete package is prepared in a temporary sibling directory and renamed
only after all inputs have been checked and files flushed. Interruption can leave
an incomplete temporary directory or a complete output without its receipt;
inspect and reconcile it instead of overwriting or uploading it blindly.

These manifests must come from reviewed public builds with verified source/CI
provenance. Matching a supplied hash does not authenticate a supplied manifest.
The caller must pin the plan and receipt, hold the normal deployment lease, and
upload only the verified assembled directory. Never point this tool at a member
data directory or treat arbitrary local files as approved public assets. Packaging
has a 100 MiB total limit, 25 MiB per-file limit, 20,000-file limit and at most 100
retained builds; exceeding a bound stops the release rather than silently pruning.

## Rollout and rollback contract

Before activation, prepare both the candidate package and a compatible rollback
package with the same union of supported immutable assets. The rollback shell
uses the baseline files, while its asset union includes files that clients may
have seen during the candidate rollout. Rolling back to the original unaugmented
version cannot promise those new URLs will work. Verify this prepared rollback
version through staging and record its exact identity in the recovery plan.

Keep the selected prior manifests and bytes as durable release artifacts. Do not
infer a safe retention window from filesystem timestamps or delete files merely
because another daily release succeeded. The supported client overlap period
still needs to be established and tested. This tool performs no automatic pruning.
Changes to mutable root assets require a separate compatibility review; version
their URLs when differing bytes must coexist.

Cloudflare versions include their own static assets. Its
[version-affinity documentation](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)
describes the mixed-version asset problem during gradual rollout. Affinity alone
does not establish continuity after switching all traffic to a new version.

## Validation and remaining integration

Seven tests cover old module dependencies, candidate shell preservation, rollback
asset overlap, immutable conflicts, missing/tampered files, traversal/symlinks,
deduplication and native CLI execution. A local assembly using the actual verified
`52949ef0` and `9800b842` public builds retained the two missing files with their
original hashes in a 27-file, 4,862,599-byte package. It made no provider changes.

The reusable Chromium check starts a loopback-only server that serves the old
HTML document, then serves subsequent asset requests from the selected newer
package. Run it against the actual public build directories:

```sh
node scripts/release-assets-browser.ts /private/old-build /private/new-build /private/assembled-assets
```

It requires the installed Playwright Chromium browser. Requests outside the local
origin are blocked, service workers are disabled so cached files cannot hide the
failure, and any API request receives a local unauthenticated stub. The first run
must reproduce the broken startup without retention; the second must render the
login form, have no module-MIME or page errors, and return exact old asset hashes.
It prints both results and fails unless the negative and positive controls agree.
This is a deployment-race startup check, not a signed-in session or API-compatibility
test. The same actual builds reproduced a non-rendering page without retention
and a working login form with retention, including the old CSS, React and crypto
module hashes. Hosted activation and authenticated traffic remain unverified.

For an already-open tab, add `--open-tab`:

```sh
node scripts/release-assets-browser.ts /private/old-build /private/new-build /private/assembled-assets --open-tab
```

This mode renders the old login document first, verifies its actual lazy modules
have not been requested, retains a typed form value, and then switches the server
to the target package. The same page imports those cold modules without reload.
A separate browser context renders the target login page with no old cache.
The negative control must fail the old lazy import while both documents remain
rendered; the retained package must load it with exact old entrypoint bytes and
no old-page errors. Both fresh contexts must also have zero JavaScript page errors
and zero module-MIME errors. A visible login form alone cannot establish that
the new client initialized successfully. Run the same sequence in reverse with the rollback package.
The result labels this byte coverage explicitly; it is not a full module-graph
hash check. This remains a local unauthenticated asset test, not proof of signed-in
feature behavior, encryption or native-client compatibility.

The October 29 regression check reproduced a false pass when the new client
rendered its form and then threw, or caught a failed dynamic import served as
HTML. The CLI now reports the fresh context's error counts and rejects both
cases. Three real-Chromium tests cover those failures and the healthy transition;
the browser CI job runs them explicitly with `RELEASE_ASSET_BROWSER_TESTS=1`.
They use synthetic public builds and a loopback server, with no hosted requests
or member accounts. This hardens the local checker; historical private hosted
helpers and earlier release receipts are not retroactively changed or accepted.

Verify deployed assets read-only against the saved package receipt:

```sh
node scripts/release-assets-verify.ts https://staging.porchday.com /private/release/asset-receipt.json
```

The verifier accepts only staging and the canonical production origin. It checks
every public file's exact hash and allowed MIME type, with four concurrent reads,
ten-second request deadlines and a 25 MiB streamed body cap. It records failures
alongside successful checks and exits unsuccessfully if any file fails. Redirects
are rejected. `index.html` and `app-shell.html` use the public `/app-shell` route;
`_headers` is provider configuration and is explicitly excluded from HTTP checks.
Unknown file types stop validation for review instead of silently skipping files.
Six tests cover false HTTP-200 success, shell routing, errors, cancellation,
concurrency, input restrictions and the streamed body limit.

Read-only checks passed all 24 current public files in staging and production.
Checking the assembled retention manifest against staging correctly failed the
two missing old files with `content_type` despite HTTP 200. This is pre-deployment
evidence; it does not mean the retained package is hosted yet.

Before claiming this fixes deployed continuity, integrate the package and rollback
artifacts into the reviewed release command, upload through staging, verify every
retained URL's hash and MIME type, and exercise a previous-release browser before,
during and after activation. Then verify the same controlled production rollout
with continuous authenticated journeys. API/schema compatibility, native clients,
feature flags, configuration and capacity remain separate release gates. Static
packaging tests do not establish zero downtime or the monthly availability SLO.

## Maintained hosted observer

`beginHostedAssetTransition` in `scripts/release-assets-hosted.ts` replaces the
one-off open-tab observation logic for future rehearsals. It accepts the canonical
staging or production origin and reviewed baseline/candidate public manifests.
It clones and hashes those manifests, verifies baseline HTML/entry bytes and
requires every discovered cold lazy entrypoint to be retained with its old hash.
Only an optional single previously observed Cloudflare analytics element at the
closing body boundary can be removed for HTML comparison. Other changes fail.

Prepare the observer before the maintained activation command, then persist its
`baselineReceipt` before dispatch. Run the existing durable command exactly once.
Only after that command reconciles the expected candidate should the caller run
`finish()`, persist the complete returned report, and require `passed === true`.
A failed/rolled-back/unknown command is not permission to claim the candidate
transition or replay deployment. Keep its original journal and reconciliation
path. A rollback observation needs manifests matching that actual transition.
Always call `close()` in `finally`, including if receipt persistence fails.

The observer opens fresh ephemeral Chromium contexts, blocks service workers,
and permits only same-origin GET browser requests. It never logs in or submits
the typed synthetic form value. The entry fetch rejects redirects and streams
at most 25 MiB; browser response buffers are checked after receipt. Error messages
are not copied into reports, only error counts. `finish()` can start once, closes
the browser afterward, and checks both old and fresh contexts. Cancellation and
a five-minute default lifetime also close it; the configurable lifetime cannot
exceed ten minutes. Timing out never produces a passing report.

Twelve tests include real Chromium with synthetic response bytes, negative
controls for fresh exceptions/MIME errors, changed old bytes, stale candidate
HTML, missing retention, cancellation, lifetime expiry, manifest mutation, and
blocked off-origin GET/same-origin POST requests. The browser CI job runs these
alongside the local transition tests. A first test invocation exposed test-runner
rewriting of a browser dynamic import; the import now executes as an encoded
browser expression, and the positive and negative controls pass.

A read-only smoke on staging at **23:08:41 UTC October 29** passed with the same
manifest as baseline and candidate: one cold lazy entrypoint loaded, old form
state remained, fresh HTML matched, both contexts had zero page/MIME errors,
and all 33 public HTTP asset checks passed. Canonical state was unchanged and
there were no provider writes. The same-version smoke establishes hosted
observer operation, not a new deployment transition. Existing-session API
continuity, signed-in UI, installed service workers, native clients and scheduled
release adoption remain separate acceptance requirements under #3.

## Frontend activation with browser evidence

`executeFrontendActivationWithClients` in
`scripts/release-frontend-observation.ts` wraps the maintained
`executeActivationWithContinuity` controller. Call it with the immutable activation
manifest path, release environment, authenticated continuity observation and abort
signal. It accepts only a frontend target in the matching observation environment.
The proof directory must already be canonical, private and owned by the operator.

The wrapper rejects completed or non-prepared operations, checks the permanent
continuity gate, and writes an exclusive, fsynced intent. It prepares the hosted
browser and durably records its baseline before recording command intent and
dispatching the maintained controller exactly once. Controller observations also
check that the browser remains connected until candidate browser verification
begins. Complete command and browser results are retained
separately; failures retain a fixed, redacted attention disposition and queue the
existing release alert locally. Delivery still requires the existing alert relay.

An existing intent always requires reconciliation, including when preparation
failed before dispatch. Never delete receipts to retry a started or uncertain
operation. Preserve the original journal and reconcile its outcome read-only.
Cancellation and browser closure are mandatory; a failed close is also attention.

Browser acceptance now occurs **inside candidate verification, before completion
and finalization**. A required, operation-and-plan-bound browser gate is written
before dispatch. The existing API/asset verifier must first return healthy; browser
evidence can only downgrade that result. A confirmed browser failure returns
unhealthy and enters the existing compatible rollback path, including fresh
provider observation, authorization and restored-baseline verification. The failed
candidate observer does not gate baseline verification. Inconclusive browser
results, cancellation or exceptions remain unknown and require reconciliation.

Required, claimed and result receipts are private, exclusive and fsynced. Resume
reads the same receipts even through the ordinary activation entry point. A lost
browser, interrupted claim or missing result cannot be silently accepted or
re-executed. An absent browser requirement preserves compatibility for earlier
operations; eligible new frontend releases must use this wrapper to enroll.
Browser work observes the controller's existing verification deadline. Browser
closure after its check is expected and does not cancel rollback or the remaining
authenticated continuity samples.

The earlier wrapper commit collected browser acceptance after finalization; this
revision moves it before the recovery decision. It is not yet adopted by scheduled
releases or verified across a new hosted deployment. Local recovery tests with
real Chromium and synthetic transport demonstrate both successful completion and
rollback on a fresh-client exception; they do not mutate a provider or establish
hosted rollback timing. The 45-second candidate-verification limit is unchanged.

Nine wrapper tests cover receipt ordering, one-time dispatch, historical-state
rejection, failed baseline persistence, rollback/unknown/error outcomes, browser
acceptance failure, observer liveness and failed closure. Durable-gate tests cover
missing/claimed evidence, cancellation, record integrity, failed API verification,
resume without replay and all three recovery outcomes. Wrapper tests use mocked
controller/browser boundaries and real private filesystem receipts; they
do not establish hosted deployment or signed-in client continuity.

The final combined run passed all **94 tests across eight suites**, including the
two Chromium-to-recovery cases. Asset and deployment-recovery TypeScript checks,
module imports, formatting, secret scanning and diff checks passed. No hosted
deployment was made for this change.
