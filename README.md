# Porchday

A simple social network for people who know each other. No ads, no influencer mechanics, and a chronological feed. The intended operator is a philanthropy-funded nonprofit; legal status and independent security review are launch prerequisites.

Porchday is under active development. The repository is private during development. Application source is licensed Apache-2.0; dependency license notices apply separately.

## Project policies and history

See the [contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md), [changelog](CHANGELOG.md), [security-reporting policy](SECURITY.md), and [name/branding statement](TRADEMARKS.md). Public reporting contacts and branding-rights ownership remain explicit launch gates; these files do not announce public source availability or a staffed response service.

## Architecture

- React + TypeScript PWA, Cloudflare Worker API/static assets.
- PlanetScale Postgres through separate Hyperdrive auth/social/jobs bindings, query caching disabled.
- Private Cloudflare R2 ciphertext storage and idempotent Queue/Cron cleanup.
- Email/password accounts, invitation-only enrollment and Cloudflare transactional email.
- Standard OpenPGP client-side encryption, maintained libraries, native/web interoperability tests.
- SwiftUI iOS client; full Xcode and an iOS Simulator runtime required for simulator verification.

## Develop

Use Node 24+ and Docker. Run `npm ci`, then the documented local database setup. `npm test` runs crypto and unit tests; database integration tests require `TEST_DATABASE_URL`. `npm run typecheck` validates workspace types. `npm run build` builds the web app.

The design in [design/social-network-design.md](design/social-network-design.md) defines the complete feature and security requirements. [docs/build-status.md](docs/build-status.md) tracks actual evidence and outstanding work. Do not infer readiness from this README.

The [portable archive contract](docs/archive/README.md) includes its schema, synthetic samples, version policy and importer guide. The [integration API guide](docs/integration-api.md) documents the implemented consent flow, scopes and limits. These documents are checked into this private repository; they do not announce a public API or source release.

## Secrets

Credentials are outside the repository in `~/.config/inner-circle/secrets.env`. `scripts/with-secrets.py` runs a trusted command with that environment without printing values. Never source the file as shell code, embed credentials in commands/URLs, log them, or commit them. Production credentials never reach clients. Encryption recovery keys are generated on member devices, not by deployment tooling.

## Deployment and verification

Infrastructure resource names are recorded in `infra/resources.json`. Use separate staging and production databases, R2 buckets, queues, auth secrets and encryption test identities. Complete the requirements checklist and real deployed tests before declaring the MVP ready. Public source release, App Store/TestFlight distribution and independent review are separate milestones.

The [operations guide](docs/operations.md) links the admission and deployment procedures. Use the [monitoring runbook](docs/independent-monitoring.md), [staff Access procedure](docs/staff-access.md), [incident response guide](docs/incident-response.md) and [restore-safety procedure](docs/restore-safety.md) for their respective operational checks. The [hosted web/PWA checklist](docs/hosted-verification.md) and [hosted native procedure](docs/hosted-native-verification.md) define remaining acceptance work; deployment alone does not establish that those checks passed.

The shared corn logo source is `apps/web/public/icon.svg`. After editing it, run `node apps/web/scripts/generate-icons.mjs` with the project's Playwright Chromium installed. This regenerates the transparent orange website mark (`logo.svg`), web/PWA PNGs, iOS app icon and native in-app mark from the same vector; inspect the generated assets before committing them.

## Operator handoff

| Surface | Address / starting point |
| --- | --- |
| Production web app and installable PWA | [porchday.com](https://porchday.com); registration remains closed. |
| Staging web app and PWA | [staging.porchday.com](https://staging.porchday.com); invited signup is enabled for owner development. |
| Status | [Production](https://status.porchday.com) and [staging](https://staging-status.porchday.com). These monitors share Cloudflare's platform. |
| Staff account recovery | `/staff` on the corresponding app hostname; personal Access login, MFA and an assigned application role are required. |
| Native iOS simulator | [Native CI](https://github.com/bobbyhwilder/porchday/actions/workflows/ios.yml) supplies the tested simulator archive and screenshot. For local builds, use `apps/ios/build-native.sh` with full Xcode, an installed iOS Simulator runtime, Go and XcodeGen. |
| Source | [Private GitHub repository](https://github.com/bobbyhwilder/porchday), Apache-2.0 licensed. Publishing it remains an owner decision. |

Start with the current deployment and open acceptance items in [build status](docs/build-status.md). A public `/health` response establishes basic availability only; the private operations check and monitor also evaluate cleanup, backups, email and review queues. A green status does not prove inbox delivery or pilot capacity.

For a release, review additive migrations and run the documented verification first. Render the intended environment with `python3 scripts/configure-worker.py staging` or `production`, compare its version and full settings with the provider immediately before deployment, and preserve the existing signup policy, bindings, secrets and logging restrictions. Check both public/protected health and served assets afterward. Keep rollback compatible with the installed schema. See [operations](docs/operations.md) for environment-specific credentials and steps; never deploy the local-verification configuration.

For an incident, use the [incident runbook](docs/incident-response.md) and [bounded queue recovery procedure](docs/queue-recovery.md). For a restore, follow [restore safety](docs/restore-safety.md): isolate the target and replay independent privacy/deletion decisions before allowing traffic. Daily database backups and private media snapshots have seven-day retention. A restore must not revive expired or deleted content. Staff-led ownership recovery cannot recover missing content-encryption keys.

The latest bounded cost inventory records approximately **$60/month in platform base charges before usage and overages** ($55 PlanetScale plus $5 Workers Paid), excluding support/moderation and other operating expenses. The last confirmed paid setup invoice is $5; recent accrued usage is not fully reported. The $10 usage alert is enabled, but is neither a hard cap nor the cumulative setup budget. The authorization is **$1,000 total setup spending**, not a monthly budget. Consult the dated [cost ledger](docs/cost-ledger.md) before making further commitments.

Completion and admission are separate. Delivered-email password-reset acceptance is complete. Email-change and recipient invitation signup/verification still need human participation. Before admitting real pilot members, complete independent encryption/security review, staffed moderation and two-person recovery, legal/nonprofit/contact disclosures, operating-budget approval, and the remaining accessibility, capacity and alert-delivery checks. Physical-device signing, APNs/universal links and App Store/TestFlight distribution require separate Apple setup. Google/GitHub login, Datadog and technical proof of humanity are deferred. The [verification record](docs/build-status.md) distinguishes actual hosted evidence from local/simulator checks and unverified claims.
