# Exact-source CI authorization

`scripts/release-ci.ts` verifies explicitly pinned GitHub Actions run IDs and
attempts for `porchday/porchday`. It requires successful push runs for the exact
full source SHA, `.github/workflows/ci.yml` with its `verify` job, and
`.github/workflows/secret-scan.yml` with its `history` job. PR merge runs, fork
heads, mutable refs, missing/skipped jobs, changed attempts and pending or failed
runs do not satisfy the gate. It checks each run again after reading its jobs.

The caller supplies reviewed workflow SHA-256 pins. The gate reads workflow bytes
from immutable Git blobs at the candidate commit and compares them to those pins.
Do not derive trusted policy from an arbitrary candidate merely because its
workflow passed: a candidate can weaken its own tests. Workflow changes require
explicit review of the new policy. Editing working-tree workflow files cannot
change the bytes checked for an existing commit.

The default reader uses the authenticated `gh` CLI with an explicit github.com
hostname and GET method. Only run and attempt-job endpoints are accepted; it cannot
dispatch or rerun workflows. Reads have ten-second deadlines, two-MiB output caps
and caller cancellation. CLI failures return fixed codes without raw stderr.
The proof records the source, workflow hashes, run/attempt/job IDs and GitHub URLs.
Persist and hash that proof in private release evidence before dispatch.

This is a fresh check, not perpetual authorization or an atomic GitHub snapshot.
Run it under the release lease immediately before upload/activation as required by
the release plan. Check every relevant source independently when code, web assets
and release tooling come from different commits. Success for a tooling commit
does not authorize a different runtime or asset source. CI alone does not prove
that local executable bytes came from that build; preparation and artifact
provenance remain required.

The live reader verified both successful push runs for
`585e36d7560b76f5240dd996ec64a08d7a9862e8` on October 29, using workflow policy
reviewed at `4bc8776a04338c21844a08091f01840bd1535e61`. Six tests cover identity,
workflow bytes, job completeness, run-attempt changes and fail-closed inputs.
No workflow or provider write was performed. Normal release command integration
and hosted continuity acceptance remain outstanding.
