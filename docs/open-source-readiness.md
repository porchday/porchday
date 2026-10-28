# Open-source publication record

Updated October 27, 2026. [porchday/porchday](https://github.com/porchday/porchday) is public under [Apache License 2.0](../LICENSE), and [porchday.org](https://porchday.org) links to the source and license. [Issue #16](https://github.com/porchday/porchday/issues/16) records the final commits, checks and closeout. Raw scanner output, provider receipts and synthetic account material stay in private operator storage.

This is a source-publication and credential review, not an independent application/cryptography audit, capacity certification or approval for broader admission. The [build status](build-status.md) and [security policy](../SECURITY.md) retain those limits.

## Repository and reporting

The repository became public on October 27 at 19:42 UTC. Anonymous requests verified the repository, reviewed source and Apache-2.0 license. The earlier organization transfer preserved its immutable GitHub identity and history.

GitHub private vulnerability reporting is enabled. The public **Security → Advisories → Report a vulnerability** control was verified, and submission correctly requires GitHub sign-in. Use the [private reporting form](https://github.com/porchday/porchday/security/advisories/new). Actual maintainer email delivery has not been independently verified; no real vulnerability report was submitted as a test. Maintainers should watch alerts and check the private advisory queue.

Secret scanning and push protection are enabled. The accessible secret-alert and advisory inventories were empty at publication. External contributors require approval to run Actions workflows; default workflow permissions are read-only and cannot approve pull requests. No repository Actions secrets/variables, self-hosted runners or environments were present in the publication inventory. Wiki and discussions were disabled. No branch-protection rule or ruleset was configured; none is claimed.

Conduct reporting follows [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md): GitHub Support handles violations of GitHub policy. This is not a private Porchday conduct inbox or a route covering all conduct outside GitHub. Private vulnerability reporting is not a general conduct channel.

## Credential and publication-surface review

The final pre-publication source checkpoint at [`9e3748c`](https://github.com/porchday/porchday/commit/9e3748c75b4389707a56424af9d12c804b905d85) covered 53 local/fetched refs, 274 commits, 1,677 complete historical blobs (25,712,445 bytes), and 594 current files. All advertised remote refs were covered. A renamed Codex checkpoint ref did not change reachable objects; its final metadata was rescanned.

Four configured Gitleaks scans covered history, complete file versions, current source and commit/tag/path/ref metadata, with zero findings. Default-rule and raw-byte findings were separately reviewed as exact synthetic cryptography/connection-validation fixtures or non-authenticating provider identifiers. No unclassified finding or sensitive credential filename remained. Private comparisons against configured credentials, the active GitHub CLI credential and authorized temporary passwords found no matches, including common encoded forms. Ordinary Git author attribution remains in history.

The retained-output inventory reached 305 Actions runs and 40 artifacts, with completed logs and expanded artifact contents reviewed through the publication candidate. Issues/comments, pull-request metadata, releases and other available publication surfaces were examined. Findings were exact synthetic fixture copies and two provider-verified deployment UUIDs. The existing issue image contained only the corn logo. Known-credential comparisons found no matches. Eight regenerable Actions caches were removed and absence verified before publication; later CI can create new caches.

The subsequent reporting-documentation commit, website release and this closeout receive a scoped delta review recorded in issue #16, including their new CI outputs. No confirmed live credential was found in the reviewed material, and no source finding required history rewriting or rotation. This is not proof that every possible credential or encoding is detectable, or coverage of future commits.

Earlier checkpoints remain in Git history: `b16577a` (198 commits / 1,263 blobs), `a279c80` (202 / 1,331), and `9fced8a` (211 / 1,396). Their former private-repository/access limitations are superseded by the settings verified above.

## Documentation and development verification

The [README](../README.md), [web setup](../apps/web/README.md), [native setup](../apps/ios/README.md), [contribution guide](../CONTRIBUTING.md), security/conduct policies, branding policy, changelog and issue/PR templates distinguish current implementation, deferred plans, enabled invitation-only signup and broader admission requirements.

Clean local verification passed dependency installation, disposable PostgreSQL migrations and integration tests, 746 application/script tests, the crypto suite, typechecks, web build, formatting/secret-guard regressions, notice generation, emoji consistency and Go interoperability. No hosted credentials or member data were used. [Application CI](https://github.com/porchday/porchday/actions/runs/40570583748) and [secret scanning](https://github.com/porchday/porchday/actions/runs/40570583655) passed for the publication commit.

A separate clean archive of main `85020ff` passed `npm ci`, all 53 local migrations, `npm run dev:api`, and `npm run dev` with Node 24 and PostgreSQL 17. API health and Vite returned 200; the proxied unauthenticated member endpoint returned 401. The documented ports were used inside an isolated container network because the host database port was occupied. No host ports, existing databases or hosted credentials were used, and owned containers were removed afterward. This closes the earlier API-startup gap; it does not test hosted email or queue behavior.

Full Xcode was unavailable locally. Native source/workflow equivalence was checked against passing [native CI](https://github.com/porchday/porchday/actions/runs/40476637317); no new local simulator or physical-device run is claimed. Dependencies retain their own licenses and [notices](../THIRD_PARTY_NOTICES.md). Publication does not replace client-distribution obligations or establish nonprofit status or trademark ownership.

## Website release

Website commit [`9800b84`](https://github.com/porchday/porchday/commit/9800b8422d3ae17b77149ab7675696cf43e60de7) contains the reviewed public-source copy from main while preserving the deployed production API. Its [application CI](https://github.com/porchday/porchday/actions/runs/40572400973) and [secret scan](https://github.com/porchday/porchday/actions/runs/40572400994) passed before deployment.

The same website assets were verified on staging, then production:

| Environment | Backend version | Public front end |
| --- | --- | --- |
| Staging | `859966df-6143-4ed1-aef0-7556f52701ba` | Edge `3855821a-ba2f-4243-934d-d838025ec7f7` |
| Production | `359d312b-c437-430c-9839-dab3362fea7f` | The same backend owns public domains |

Production retains the exact `d2835d1` API executable; staging retains its `e57f396` backend/edge executables. Only static assets changed. Signup, bindings, queues, privacy safeguards, placement, domain ownership and 52 applied hosted migrations were preserved. The unreleased group-invitation migration 052 on main was not applied by this release.

Checks covered 24 served files against build hashes, home/About/Principles at 1280/375/320 pixels, source/license links, login/join pages, security headers, protected health and the signed-in sidebar using synthetic accounts with normal encryption setup. Production `.com` public navigation still redirects to `.org`; legacy `/login` and `/app` stay available with `noindex`, and an anonymous legacy member API request returns 401. A network error in the initial legacy-path check was retained; a separate read-only recheck passed. No real-member device/key migration is claimed.

Each environment passed 30 synthetic bootstrap reads and 30 empty-feed reads with healthy aggregate API telemetry. Production also passed two such checkpoints before release. Both new synthetic accounts were removed and their old sessions returned 401. Provider state and the canonical deployment record were reconciled before releasing the owned deployment lock.

These bounded checks do not resolve [issue #40](https://github.com/porchday/porchday/issues/40), which remains open for the original connection-exhaustion cause, durable correction and its separate older-fixture cleanup. The failed topology was not re-promoted and its watch remains paused. Follow the current deployment record and [operations guide](operations.md); dated private release helpers are not reusable rollout commands.

## Ongoing safeguards

The [local secret guard](../scripts/check-secrets.py) checks tracked and nonignored candidate files, including binary/large files and credential filenames, without printing values or following symlinks outside the checkout. Regressions cover chunk boundaries, key formats, remote database credentials, forced-added ignored files and filename redaction.

The [secret-scan workflow](../.github/workflows/secret-scan.yml) uses checksum-pinned Gitleaks and scans full reachable history and complete file versions. [Exceptions](../.gitleaks.toml) are limited to reviewed rules, paths, exact synthetic values and public identifier fields; there is no blanket test-directory exclusion. Scanner errors are failures, and raw findings are not published.

Keep credentials and private evidence outside Git. Provider resource/version IDs and public hostnames are identifiers, not credentials or a configuration ready for another operator to deploy. Review new code, logs, attachments and artifacts before publishing them. Future changes require their own checks.
