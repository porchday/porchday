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

Before claiming this fixes deployed continuity, integrate the package and rollback
artifacts into the reviewed release command, upload through staging, verify every
retained URL's hash and MIME type, and exercise a previous-release browser before,
during and after activation. Then verify the same controlled production rollout
with continuous authenticated journeys. API/schema compatibility, native clients,
feature flags, configuration and capacity remain separate release gates. Static
packaging tests do not establish zero downtime or the monthly availability SLO.
