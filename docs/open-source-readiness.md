# Source publication review

Initial review: October 26, 2026, starting from `b16577a4be6f27cd013ec2d4b92f2577f504189b`. The owner subsequently authorized public source publication and transferred the repository to [porchday/porchday](https://github.com/porchday/porchday). [Publication issue #16](https://github.com/porchday/porchday/issues/16) records the final commit, checks and GitHub settings. This is a credential and publication-surface review, not an independent application or cryptography audit, and it does not authorize a production deployment.

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

The owner selected GitHub for reporting. At publication, a repository administrator needs to enable and verify **private vulnerability reporting**, including report access and notifications. The pre-publication checkpoint used a collaborator with push/triage access; it could not perform the visibility or reporting-setting changes. Those final actions and their verification belong in publication issue #16, rather than being inferred from this document. [SECURITY.md](../SECURITY.md) records the intended route and current state. GitHub's [configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) apply to public repositories.

Conduct reports use GitHub's abuse-reporting process as described in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md). It is a route to GitHub Support for violations of GitHub's rules, not a private Porchday inbox or a general reporting process for conduct outside GitHub.

Before changing visibility, verify that the final source checks pass and review changes or CI artifacts created after this dated inventory. Keep any new secrets or private member data out of source, issues, attachments and logs. The owner has explicitly authorized making the source public. Production signup, runtime configuration and deployed code are unchanged by the repository visibility change.

## Final verification

The retained-output review is complete with no confirmed live credentials. Seven Python guard/formatting tests, first-party formatting and whitespace checks pass. The final pushed revision and its CI outcomes are recorded in [publication issue #16](https://github.com/porchday/porchday/issues/16); the detailed raw audit evidence stays private.

## Follow-up review before publication

The repository transfer preserved its immutable GitHub identity and existing issues/history. A fresh source checkpoint at `a279c80` covered 12 refs, 202 commits, 1,331 complete blobs (about 19.7 MB), commit/tag/path/ref metadata, and 501 current files. All four configured Gitleaks scans returned zero findings. Independent private comparisons against configured credentials and authorized disposable test-password files also found no matches. Default-rule findings were independently classified as public identifiers or exact synthetic fixtures; the existing narrow exceptions were unchanged, and five negative controls passed. A historical PostgreSQL-shaped string detected by the raw-byte supplement was a literal synthetic connection-validation fixture, not a hosted credential.

The corresponding GitHub delta covered nine new completed Actions logs, one native artifact and current repository/issue/comment metadata: 369 expanded files, about 37.8 MB. No configured credential or test-password matches were found. General-scanner matches were exact synthetic crypto fixtures and a previously verified Swift Testing binary. The provider-generated temporary clone credential in an authenticated repository API response was audit-only data, removed from the retained sanitized inventory; it was not in Git, an issue, an Actions log or an artifact. Raw evidence is never committed or attached to issues.

At that checkpoint there were 18 issues and five comments, no pull requests or releases, no commit comments, and no enabled wiki or discussions. Changed issues and comments contained public project/status material, not member data or account-action links. The published-advisory endpoint was unavailable to the collaborator; an administrator must check it, rather than interpreting that result as an empty inventory. Three regenerable Actions caches were enumerated but not content-audited; their final disposition is recorded in issue #16.

Contributor-facing links now use `porchday/porchday`, while dated historical CI evidence retains its original URLs. The documentation no longer assumes repository privacy, includes current `.org` and legacy-device behavior, and preserves enabled signup in smoke/deployment guidance. The notice source and generated web/native copies use visibility-neutral license wording; dependency licenses and attribution are unchanged. Those generated notices need a new client build to appear in distributed clients; changing GitHub visibility does not redeploy an application.

The final documentation commit, its complete-source rescan, and any CI outputs generated after this checkpoint must pass the final delta review. Their exact results are recorded in publication issue #16 so this dated report does not imply coverage of future commits. GitHub visibility, private reporting and maintainer notification checks remain explicit settings checks, separate from a clean credential scan.
