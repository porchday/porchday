# Contributing to Porchday

Porchday development is tracked in [`porchday/porchday`](https://github.com/porchday/porchday). Original source is licensed under Apache-2.0. This guide covers local development, contribution checks and project policies; contributing does not require access to the hosted service.

Start with the [README](README.md), [product design](design/social-network-design.md) and [implementation record](docs/build-status.md). The design describes the intended product; the implementation record distinguishes delivered behavior, verification and remaining work. Nonprofit operation is the intended model, not a legal status established by this repository.

## Propose a change

Search [open and closed issues](https://github.com/porchday/porchday/issues) before filing a bug or proposing a feature. For a bug, include the affected build and platform, expected and observed behavior, and a small reproduction using synthetic data. Follow the [issue-tracking workflow](AGENTS.md): delivered work awaiting acceptance stays marked `needs verification`, and deferred work does not become a release requirement without a scope decision.

Discuss changes to encryption, access rules, data lifecycle or product scope with the maintainer before implementation. Preserve the chronological feed, 300-connection limit including family, no-ad model, human-operated accounts and data portability. Audience restrictions, inherited expiry and recovery safeguards must not be weakened to make a test pass. Suspected vulnerabilities belong in the private reporting process in [SECURITY.md](SECURITY.md), not an ordinary issue or pull request.

Follow the [code of conduct](CODE_OF_CONDUCT.md). Repository maintainers control collaborator access and release decisions. The GitHub organization and repository administration do not establish a nonprofit entity or trademark owner.

## Develop locally

Use Node 24 (the CI version), npm, Python 3 and Docker for disposable PostgreSQL 17. Install the locked dependencies:

```sh
npm ci
```

Follow the [web development setup](apps/web/README.md#local-setup) for disposable database creation, migrations, synthetic invitations and locally captured verification emails. Then run these in separate terminals:

```sh
npm run dev:api
npm run dev
```

Use synthetic accounts and the local email/media adapters. Local development does not need production credentials. Never point development or test tools at a hosted member database.

For native work, use the [iOS build instructions](apps/ios/README.md). Full Xcode, an installed simulator runtime, XcodeGen and the Go version pinned in the native module are required. Simulator builds do not require an App Store listing. The [native CI workflow](.github/workflows/ios.yml) is the executable reference.

## Verify a change

Run the checks relevant to your change, and the standard checks before submitting a code change:

```sh
python3 scripts/check-format.py
npm run typecheck
npm test
npm run build
python3 scripts/check-secrets.py
```

The [Linux CI workflow](.github/workflows/ci.yml) defines the full disposable database setup. It supplies `TEST_DATABASE_URL` plus eight suite-specific test URLs, applies migrations to the base database, and runs `node scripts/prepare-test-databases.ts` before `npm test`. The preparation command creates local databases and needs a role with that permission. Without those URLs, some integration tests skip: a passing partial run is not full database coverage. Record skipped checks and unavailable tools explicitly.

Add regression coverage for changed authorization, expiry, encryption, recovery, media, retries and deletion. Shared payload changes need JavaScript/native compatibility checks. Use a new numbered migration for schema changes; do not rewrite applied migrations. Check restricted runtime roles and restore/deletion behavior as well as a privileged local connection. Documentation-only changes need accurate links and commands, not new application tests.

Keep pull requests focused. Describe the concrete problem, resulting behavior, compatibility or migration effects, and checks performed. Distinguish local tests, CI, isolated provider probes and hosted acceptance. Update the relevant documentation and [changelog](CHANGELOG.md) for behavior changes.

## Keep private material out of contributions

Do not commit credentials, member data, encryption/recovery material, private reports, local evidence or generated build output. Inspect screenshots, logs and fixtures before attaching them. A passing pattern scan does not replace that review. Use the [formatting policy](docs/formatting.md) for text changes.

Deployment credentials stay outside the checkout; the project convention is `~/.config/inner-circle/secrets.env`. The [README](README.md#secrets) documents the trusted command wrapper. Do not execute that file as shell code, copy its values into commands or URLs, or expose them to a client bundle. Normal CI uses disposable resources and synthetic credentials. A contribution or passing CI run does not authorize deployment or a change to repository visibility.

## Licensing and dependencies

Original Porchday code uses [Apache License 2.0](LICENSE). Contributions intentionally submitted for inclusion follow its contribution terms unless explicitly stated otherwise. Submit only material you have the right to contribute and retain upstream notices.

Dependencies retain their own licenses. Review upstream and transitive licensing when changing dependencies. Update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [third-party-licenses](third-party-licenses) and app-visible notices with `python3 scripts/build-third-party-notices.py` where applicable. Follow the documented corresponding-source and replacement-build requirements before distributing clients; the root Apache license does not relicense dependencies.

Names and branding are addressed in [TRADEMARKS.md](TRADEMARKS.md). Source publication and broader service admission are separate decisions. Use the reporting routes and availability stated in [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). GitHub abuse reports cover GitHub policy violations, not a general private Porchday conduct process.
