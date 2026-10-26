# Open-source preparation

Reviewed October 26, 2026, starting from `b16577a4be6f27cd013ec2d4b92f2577f504189b`. The repository remains private. This review prepares the source for publication; it does not publish the repository, authorize a deployment, or establish an independent application/cryptography audit.

## Credential review

The review covered the fetched remote history and additional local checkpoint refs: 198 commits, 1,263 unique file blobs and approximately 18.75 MB of source history. The remote had one branch, no tags, no pull requests, no releases, and no enabled wiki or discussions at inventory time.

- Gitleaks 8.30.1, verified against the official release checksum, scanned history, complete file versions, the tracked snapshot and commit metadata. Reviewed matches in source were non-authenticating Cloudflare resource identifiers or deliberately synthetic test fixtures. The retained interoperability keys belong only to synthetic fixtures; never reuse them for member accounts.
- An independent exact-value comparison against 20 configured credential fields and authorized disposable test-password files found no matches in historical blobs, commit metadata, historical paths or current tracked/candidate files. Values were compared privately, including common encoded forms; none were written into source or scan output.
- All 126 retained GitHub Actions run logs and 28 available artifacts were downloaded privately and expanded, including nested archives: 6,541 files, approximately 842 MB. The exact-value comparison found no known-secret matches. All 111 general-scanner findings in these outputs were exact copies of checked-in synthetic cryptography fixtures (22 copies of `openpgp-v1.json` and one `reactions-v1.json`); no additional suspicious value was found.
- The 14 existing dependency/build caches were deleted and absence verified. They are regenerable and were not treated as content-audited artifacts. Subsequent CI runs can create new caches.
- The 14 ordinary issues were reviewed with the remote metadata. There were no issue comments. Private scanner output, archive contents and operator credentials remain in ignored local storage, outside Git.

No confirmed live credential was found in the reviewed source or retained outputs. This is a scoped review, not proof that every possible password or encoding is detectable. GitHub's built-in secret-alert endpoint was unavailable to the authenticated collaborator; no claim is made that its alert list is empty or push protection is enabled. No Git history was rewritten and no live credential rotation or service change was required by the source findings.

## Prevention

The [fast local guard](../scripts/check-secrets.py) checks tracked and nonignored candidate files, including binary and large files, without printing matching values. It rejects private credential filenames and supported token/key patterns, handles filenames safely, and does not follow symlinks into private files outside the checkout. Four regression tests cover binary/chunk boundaries, private-key formats, local versus remote database credentials, forced-added ignored files, and filename redaction.

The [secret-scan workflow](../.github/workflows/secret-scan.yml) uses a checksum-pinned Gitleaks binary and full Git history on pushes and pull requests. It also scans complete historical file versions. [Exceptions](../.gitleaks.toml) are restricted to reviewed rules, exact paths and fixture values or specific non-authenticating identifier fields. There is no blanket test-directory exclusion. Scanner failures must not be treated as clean scans; raw matches and artifacts are not published by that workflow.

Keep hosted credentials outside Git. Cloudflare account/resource IDs, deployment version IDs, public hostnames and Access audience IDs in operator configuration are identifiers, not credentials. They remain for deployment reproducibility and are not a ready-to-deploy configuration for another operator. Never reuse the hosted bindings or deploy a raw sample without following the [operations guide](operations.md).

## Contributor documentation and verification

The root [README](../README.md), [web setup](../apps/web/README.md) and [native setup](../apps/ios/README.md) now describe the actual local dependencies, commands, integration-test environment and limitations. Current implemented/deferred scope, invitation-only production signup and completed delivered-email acceptance are distinguished from historical checkpoints. Contribution, security, conduct, branding and changelog documents have been refreshed; concise issue and pull-request templates are included.

A separate clean source checkout passed dependency installation, all 46 database migrations, the full disposable-PostgreSQL test setup, 20 crypto tests and 549 application/script tests, typechecks, web build, Go interoperability and deterministic client-source packaging. Regenerating third-party notices produced no changes. An isolated frontend server returned the application and was stopped afterward. No hosted credentials or member data were used.

The fixed-port local API was not started because another process owned its database port; the existing instance was left alone. Full Xcode was unavailable locally, so native instructions were checked against the existing native CI workflow rather than claiming a new simulator run. These limitations do not change the reported database-backed test results.

The Apache-2.0 license remains in place. Dependencies retain their licenses and [notices](../THIRD_PARTY_NOTICES.md); public source availability does not by itself complete client-distribution obligations. Nonprofit formation and branding ownership are not established by this repository. Private evidence references in the [implementation record](build-status.md) intentionally have no public artifact download.

## Publication handoff

The owner selected GitHub for reporting. At publication, a repository administrator needs to enable and verify **private vulnerability reporting**, including report access and notifications. This collaborator has push/triage access, not administrator access, and has not changed repository visibility or enabled that setting. [SECURITY.md](../SECURITY.md) records the intended route and current state. GitHub's [configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) apply to public repositories.

Conduct reports use GitHub's abuse-reporting process as described in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md). It is a route to GitHub Support for violations of GitHub's rules, not a private Porchday inbox or a general reporting process for conduct outside GitHub.

Before changing visibility, verify that the final source checks pass and review changes or CI artifacts created after this dated inventory. Keep any new secrets or private member data out of source, issues, attachments and logs. Making the source public remains an explicit owner action; production signup, runtime configuration and deployed code are unchanged by this preparation.

## Final verification

The retained-output review is complete with no confirmed live credentials. Seven Python guard/formatting tests, first-party formatting and whitespace checks pass. The final pushed revision and its CI outcomes are recorded in [publication issue #16](https://github.com/andyk/porchday/issues/16); the detailed raw audit evidence stays private.
