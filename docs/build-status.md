# Porchday implementation and verification record

The source design is `design/social-network-design.md`. No requirement is complete merely because it appears in this plan.

## Build underway

- Root: infrastructure, auth, deployment, integration, operational documentation.
- Social service: PostgreSQL constraints/RLS, social routes, expiry/media jobs, meaningful database tests.
- Web: responsive marketing + real member experience + PWA.
- Crypto: standard OpenPGP library interoperability, encrypted objects, key lifecycle, test vectors. No new cryptographic primitive or protocol; application authorization and context binding still require independent review.
- Native iOS: SwiftUI client using the shared content/API formats, simulator verification pending Xcode availability.

## External state verified

- Cloudflare account token active; Workers/R2 access available.
- Cloudflare Email Sending enabled for porchday.com; SPF, DKIM and DMARC configured. Delivery testing outstanding.
- PlanetScale billing active and organization linked. No database/Hyperdrive provisioned yet.
- Private GitHub bobbyhwilder/porchday exists; API token grants administrator repository access. Git push not tested yet.
- $1,000 total setup ceiling, not monthly. No new paid resources provisioned by this build yet.

## Environment blockers discovered

- Full Xcode and iOS Simulator are absent; user asked to install Xcode plus iOS runtime.
- Browser access is intermittent. PlanetScale database creation now redirects to a fresh sign-in; owner asked to log into the existing andykonwinski account. No new GitHub OAuth link authorized.

## Release boundaries

The deployment stays invitation-only. Independent encryption/security review, real nonprofit/legal disclosures, and staffed moderation/recovery remain pre-member/public-launch gates. The implementation must not misrepresent a private repository as publicly available source or claim that a review has occurred.

## Completion evidence still required

Real deployed auth/email, isolated DB authorization tests, cross-client encrypted objects/media, user flows in browser and iOS simulator, expiry/deletion failure/retry tests, portability/recovery, CI/push, domain/TLS, monitoring and cost alerts, documented restore drill and limits. Track each against the design acceptance scenarios as implementation lands.

## First implementation evidence

- Authentication integration test: invited signup, email verification, password reset, one-use reset and session revocation pass against PostgreSQL17.
- Full application boundary test: invalid invitations/adult rejection, one-use email verification, authenticated session, CSRF origin rejection, disabled OAuth, and takeover hold access denial pass.
- Crypto:13 tests pass, including tampering, context substitution, key recovery, lifecycle signing, reaction tags, archive encryption, and301-device audience. Native GopenPGP ↔ JS interoperability also passes; iOS simulator still unverified.
- Social agent reports9 database invariant tests and additional encrypted HTTP tests; final integrated test run pending.
- Telemetry privacy/failure tests pass. Dependency audit currently reports0 vulnerabilities.
- Separate staging/production private R2 buckets and queues created. Cloudflare email body previews disabled. One setup email was accepted/queued; delivery not yet confirmed.
- Local synthetic API is running on127.0.0.1:8787; frontend still being completed.
- Recovery report/contact verification implemented; staff review/hold/restore workflow, alerts, deployment and actual launch gates remain incomplete.

## Integrated checkpoint — 2026-10-25

- All25 migrations through024 apply to a fresh PostgreSQL17 database through the migration runner. API, web and crypto TypeScript checks pass.
- Integrated run:14 crypto tests plus40 Vitest tests pass; the2 moderation database tests require their separate database variable and are run separately. CI now includes that database explicitly. Counts will change as push/native tests land.
- Recovery tests prove safe-contact verification alone does not freeze an account, a corroborated hold removes sessions, one reviewer (including repeated votes) cannot restore access, two distinct reviewers can authorize a one-use restore link, and recovery invalidates old login credentials and recovery sessions.
- Actual BetterAuth MFA/email-change tests cover no authenticated session before second-factor verification, one-use backup codes, old-address approval followed by new-address verification, and session revocation after switching email.
- Authentication operations use an explicit PostgreSQL transaction, with identity-scoped transaction advisory locks shared by the staff recovery path. This pins the Hyperdrive connection and prevents in-flight login/reset operations from racing a reviewed takeover response. Staff routes validate Cloudflare Access signatures/issuer/audience/time claims and active application roles; staff Access deployment/MFA policy is still unconfigured.
- Web app builds with responsive marketing/member screens, PWA shell, encrypted data flows, moderation/recovery consoles, MFA, portability and profile/group media. Visual/browser and installation verification remain pending because native Chrome control currently reports no accessible window.
- Worker dry-run bundle succeeds (~688KiB gzip at this checkpoint). Local workerd serves the marketing app with CSP, returns401 for unauthenticated private APIs, applies no-store to API responses, and fails closed for unconfigured staff authentication.
- Staging/production queues now include dead-letter queues. No live Worker or PlanetScale database is deployed yet.
- Full Xcode remains absent locally. A private GitHub Actions macOS simulator workflow is being prepared/executed to verify the native app without App Store credentials. Source parsing is not a successful iOS build.
- PlanetScale CLI installed; owner asked to run `pscale auth login` into the existing organization. Cloudflare's documented CLI billing-signature flow can then provision the database without depending on the inaccessible browser window.
