# Contributing to Porchday

Porchday is under active development in the private [`andyk/porchday`](https://github.com/andyk/porchday) repository. These instructions apply to collaborators who already have access. Public source publication is a separate owner decision; the Apache-2.0 license does not make this private repository publicly accessible.

Read the [design](design/social-network-design.md) for intended behavior and the [implementation record](docs/build-status.md) for what has actually been verified. The intended operator is a philanthropy-funded nonprofit; this repository does not establish that legal status.

## Proposing a change

Use [GitHub Issues](https://github.com/andyk/porchday/issues) or a pull request in the private repository for ordinary bugs and changes. Search for an existing issue first. Describe the affected flow, expected behavior, a minimal reproduction using synthetic data, and relevant versions. Follow the [issue-tracking workflow](AGENTS.md), including keeping delivered changes open when acceptance remains unverified. Discuss changes to the encryption protocol, access rules, data lifecycle or product scope with the maintainer before implementing them. Send suspected vulnerabilities through the process in [SECURITY.md](SECURITY.md), not an ordinary issue or pull request.

Preserve the product commitments: a chronological friends feed, a maximum of 300 mutually accepted connections including family, no ads or influencer mechanics, human-operated member accounts, and practical data export/deletion. Changes must preserve audience restrictions, inherited expiry, recovery safeguards and client-side content encryption. The design is the source of detail; do not weaken a safeguard just to make a test pass.

Follow the [code of conduct](CODE_OF_CONDUCT.md). The current repository owner, [@andyk](https://github.com/andyk), controls collaborator access and release decisions. This identifies repository administration, not a legal nonprofit or trademark owner.

## Local development

Use Node 24 or newer, npm, Python 3, and Docker for a disposable PostgreSQL 17 instance. Begin with:

```sh
npm ci
npm run typecheck
npm run build
```

Follow [operations](docs/operations.md) for the local database, migrations, runtime roles, development API and local journal configuration. Run `npm run dev:api` and `npm run dev` in separate terminals after setup. Use synthetic accounts and local email/media artifacts. Do not point development or test tools at production.

The [Linux CI workflow](.github/workflows/ci.yml) is the executable reference for the complete disposable database environment. It sets all eight test database URLs, applies migrations to the base database, runs `node scripts/prepare-test-databases.ts`, then runs `npm test`. Without the database configuration, a local test run can skip integration coverage; report that limitation. Test database preparation creates local databases and requires a local role allowed to create them.

For native work, follow the [iOS build instructions](apps/ios/README.md) and [native CI workflow](.github/workflows/ios.yml). Full Xcode, an installed simulator runtime, the pinned Go toolchain and XcodeGen are required. Simulator builds do not require an App Store listing. Verify shared encrypted payloads across the JavaScript and native implementations when changing that protocol.

## Pull requests and verification

- Keep each change focused. Explain the concrete problem, resulting behavior, migration or compatibility effects, and verification performed.
- Add regression coverage for changed authorization, expiry, encryption, recovery, media, retry or deletion behavior. Use synthetic fixtures and the existing test suites; documentation-only changes need accurate links and commands rather than new implementation tests.
- Run the relevant tests, `npm run typecheck`, `npm run build`, and `python3 scripts/check-secrets.py`. Record skipped checks and unavailable tools explicitly. Native changes also need the applicable native CI checks.
- Add a new numbered migration for schema changes. Do not rewrite migrations that have already been applied. Consider restricted runtime roles and restore/deletion behavior, not just a privileged local connection.
- Update user/developer documentation and [CHANGELOG.md](CHANGELOG.md) when behavior changes. Local tests, CI, isolated cloud probes and production verification are different evidence; label them accurately.
- Do not commit secrets, member data, recovery material, private reports or generated build artifacts. Inspect screenshots, logs and fixtures before attaching them. A passing pattern scan is not a substitute for that inspection.

Keep private credentials outside the checkout. The project convention is `~/.config/inner-circle/secrets.env`; [README.md](README.md#secrets) explains the trusted command wrapper. Never execute that file as shell code or copy its values into a pull request, client bundle or test fixture. Normal CI should use disposable resources and synthetic credentials.

## Licensing and dependencies

Original Porchday code is licensed under [Apache License 2.0](LICENSE). Intentional contributions submitted for inclusion follow that license under its contribution terms unless an explicit separate agreement applies. Submit only material you have the right to contribute; retain required upstream notices.

Dependencies retain their own licenses. Review the actual upstream license and bundled/transitive notices before adding or upgrading one. Update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the relevant files in [third-party-licenses](third-party-licenses), and app-visible notices using `python3 scripts/build-third-party-notices.py` when applicable. Follow the corresponding-source and replacement-build requirements documented there before distributing clients. Do not claim that the root Apache license relicenses a dependency.

Names and branding are addressed separately in [TRADEMARKS.md](TRADEMARKS.md). A public release also requires a verified private security-reporting channel and conduct-reporting contacts; their current gaps are recorded in the respective policies.
