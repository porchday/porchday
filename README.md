# Porchday

A simple social network for people who know each other: no ads, no influencer mechanics, and a chronological feed. The intended operator is a philanthropy-funded nonprofit. Establishing that organization and completing independent security review remain launch prerequisites.

Porchday is an actively developed, invitation-only adult pilot. The repository is currently private; preparing it for open source does not change its visibility. Original application source is [Apache-2.0 licensed](LICENSE), with separate [dependency notices](THIRD_PARTY_NOTICES.md).

## What is implemented

- Up to 300 mutual connections, including family; personal walls, named groups and audience controls.
- Photos, threaded comments, and multiple Unicode or custom-image reactions per person on posts and comments.
- Optional post/comment expiration, with replies inheriting their parent's deadline or a shorter one.
- Encrypted profiles and personalization, a web/PWA client, and a native SwiftUI iOS client.
- Member invitations, email/password accounts, device enrollment, account recovery, reporting and moderation workflows.
- Local export/import, scoped integrations and deletion controls.

Private social content is signed and encrypted on member devices. The operator still processes account details and access metadata; this is not a claim that every database field is unreadable. See the [cryptographic protocol and limitations](docs/crypto-protocol.md). Password recovery and content-key recovery are separate.

Google/GitHub sign-in, Datadog and technical proof of humanity are deferred. The [design](design/social-network-design.md) describes the intended product; the dated [build status](docs/build-status.md) records what was actually verified and what remains open.

## Start developing

Use **Node 24**, npm, and Python 3. From a clone you are authorized to access:

```sh
git clone https://github.com/andyk/porchday.git
cd porchday
npm ci
npm run typecheck
npm run build
npm test
```

These commands need no Cloudflare, PlanetScale or Apple credentials. Without database environment variables, `npm test` skips the PostgreSQL integration suites. To run those suites, or to sign in to a local app, follow the [web development setup](apps/web/README.md), which uses disposable PostgreSQL 17 containers. `npm run dev` starts only the frontend; it does not provision an API or database.

For native builds and interoperability tests, see the [iOS instructions](apps/ios/README.md). Full Xcode and an installed iOS Simulator runtime are required for simulator tests; Command Line Tools alone are insufficient.

## Repository guide

| Path | Purpose |
| --- | --- |
| `apps/web` | React/TypeScript public site and PWA, built with Vite. |
| `apps/api` | Cloudflare Worker, PostgreSQL migrations and API tests. |
| `apps/ios` | SwiftUI client and simulator tests. |
| `packages/crypto` | Shared OpenPGP protocol, Unicode metadata, JavaScript and Go interoperability fixtures. |
| `scripts` | Development, verification and operator tools. Hosted scripts require explicit operator preparation. |
| `design`, `docs` | Product requirements, protocols, verification records and runbooks. |
| `infra` | Deployment resource manifest and provisioning/configuration tools. |

The hosted service uses PlanetScale Postgres through separate auth/social/jobs Hyperdrive bindings, private Cloudflare R2 storage, Queues/Cron cleanup and Cloudflare transactional email. The local development adapters are smaller substitutes; they do not verify hosted cleanup, delivery or restore safety.

The [portable archive contract](docs/archive/README.md) supplies the schema, samples and version policy. The [integration API guide](docs/integration-api.md) documents consent, scopes and limits. These are implementation contracts, not an announcement of public API access.

## Contributing and licensing

Start with the [contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md) and [branding policy](TRADEMARKS.md). Track work in [andyk/porchday issues](https://github.com/andyk/porchday/issues); the [issue workflow](AGENTS.md) defines priorities and verification status. The security policy uses GitHub private vulnerability reporting, which the repository owner must enable and verify when publishing. Conduct reports use GitHub’s abuse-reporting process, with the limits described in the code of conduct. The [open-source readiness checklist](docs/open-source-readiness.md) tracks publication requirements separately from repository visibility.

After changing dependencies or bundled data, review their licenses and regenerate the client notices:

```sh
python3 scripts/build-third-party-notices.py
python3 scripts/generate-unicode-emoji.py --check
```

To produce the tracked client source/rebuild archive locally, run `python3 scripts/package-client-source.py /tmp/porchday-client-source.tar.gz` from a Git checkout. This does not publish anything or include the server implementation. See [third-party notices](THIRD_PARTY_NOTICES.md) for distribution obligations.

## Secrets

Local development needs no hosted secrets. Existing operator tooling reads credentials from an external `~/.config/inner-circle/secrets.env` through `scripts/with-secrets.py`; that historical directory name is not a local-development requirement. Never source a credentials file as shell code, commit it, or include its values in logs, URLs or examples. Member encryption recovery keys are generated on member devices, not by deployment tooling.

Use the [operations guide](docs/operations.md) for deployment and admission procedures. Preserve the live environment's bindings, secrets, signup policy and logging restrictions; compare live settings before changing them. Never deploy `apps/api/wrangler.local.jsonc`. A successful build or public `/health` response does not establish delivery, restore safety or pilot capacity.

| Surface | Starting point |
| --- | --- |
| Production | [porchday.com](https://porchday.com); invitation-only signup is enabled for authorized owner use. |
| Staging | [staging.porchday.com](https://staging.porchday.com); invitation-only signup is enabled. |
| Status | [Production](https://status.porchday.com) and [staging](https://staging-status.porchday.com); monitors share Cloudflare's platform. |
| Staff recovery | `/staff` on the corresponding hostname; personal Access login, MFA and an assigned role are required. |
| Native verification | [iOS CI](https://github.com/andyk/porchday/actions/workflows/ios.yml); dated outcomes are recorded in build status. |

The October 26, 2026 verification record includes delivered-email acceptance for signup, ordinary password reset, stolen-account recovery, two-address email change, and member-invitation delivery through recipient signup, verification and login. See [email and invitation evidence](docs/operations.md#email-and-monitoring) and [recipient acceptance](docs/member-invitations-and-sharing.md). These checks used authorized test accounts and human inbox participation; they are not evidence for every mail provider or for bounce handling.

Broader admission remains separate from enabled signup. Outstanding requirements include independent encryption/security review, support and moderation staffing, two-person recovery coverage, nonprofit/legal/contact disclosures, operating-budget approval, and remaining accessibility, capacity and alert checks. Physical-device signing, APNs, Universal Links and App Store/TestFlight distribution require separate Apple setup.

For incidents and restores, use the [incident guide](docs/incident-response.md), [queue recovery procedure](docs/queue-recovery.md) and [restore-safety procedure](docs/restore-safety.md). Consult the dated [cost ledger](docs/cost-ledger.md) for spending evidence. Current public/private acceptance boundaries are in [build status](docs/build-status.md), [hosted web/PWA verification](docs/hosted-verification.md) and [hosted native verification](docs/hosted-native-verification.md).

## Shared artwork and installed app updates

The shared corn logo source is `apps/web/public/icon.svg`. With Playwright Chromium installed, `node apps/web/scripts/generate-icons.mjs` regenerates the website, PWA and native artwork. Inspect the results before committing.

The web build gives installed-app icons content-based URLs while preserving PWA identity. Apply Porchday's **Update now** if offered, close and reopen the installed app, and use Chrome's **⋮ → Review app update** when offered. Do not clear site data or reinstall solely to refresh artwork; see [Chrome's update behavior](https://developer.chrome.com/blog/improvements-to-web-app-updates).
