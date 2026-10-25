# Porchday

A late 90s style social network for people who know each other. No ads, no influencer mechanics, and a chronological feed. The intended operator is a philanthropy-funded nonprofit; legal status and independent security review are launch prerequisites.

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

## Secrets

Credentials are outside the repository in `~/.config/inner-circle/secrets.env`. `scripts/with-secrets.py` runs a trusted command with that environment without printing values. Never source the file as shell code, embed credentials in commands/URLs, log them, or commit them. Production credentials never reach clients. Encryption recovery keys are generated on member devices, not by deployment tooling.

## Deployment and verification

Infrastructure resource names are recorded in `infra/resources.json`. Use separate staging and production databases, R2 buckets, queues, auth secrets and encryption test identities. Complete the requirements checklist and real deployed tests before declaring the MVP ready. Public source release, App Store/TestFlight distribution and independent review are separate milestones.
