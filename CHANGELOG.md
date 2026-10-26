# Changelog

This file records notable development changes, not a list of supported releases. The package version `0.1.0` is development metadata. The repository remains private; source publication and broader service admission are separate decisions.

## Unreleased

### Development update — 2026-10-26

- Prepared the move to `porchday.org`, retaining strict same-origin `.com` account/API compatibility for existing browsers and native clients, safe public-navigation redirects, and a public PWA shell that stays available on the old origin. DNS and deployed cutover are tracked separately in issue #17.
- Prepared source publication with a history/CI-output credential review, a pinned full-history secret-scan workflow, stronger local credential checks, contributor setup verification and GitHub reporting policies. The repository remains private.
- Added a searchable, bundled Unicode 17 emoji catalog, including skin tones and joined sequences, to web/PWA and native post/comment reactions. Existing reaction identities remain compatible; members can use multiple distinct reactions.
- Added static custom-image reactions and an owner-only encrypted collection of up to 48 saved images. Included the collection in archive export/import and added the explicit `emoji:read` integration scope. Existing grants do not gain access automatically. Migration `045_emoji_library.sql` is required. Existing reactions and archives without the new collection field remain readable.
- Fixed Safari custom-image uploads by removing metadata from newly encoded canvas PNGs before validation. Received reaction bytes and their identities remain unchanged.
- Restored the autumn background and added Autumn, Clean and New pattern footer controls. Improved optional starter-profile setup, account switching and long-name layout on phones without replacing saved profile themes.
- Gave PWA install icons content-based URLs and refreshed manifest metadata online while preserving app identity and offline fallback. Existing Chrome installations may need to approve the icon update; no reinstall or site-data deletion is required.
- Completed the planned delivered-email password-reset, email-change and invited-recipient signup/verification checks. Fixed the completed email-change callback text. Production invitation-only signup remains enabled at the owner's request; this is not unrestricted registration or broader launch approval.
- Improved privacy-journal completion across interrupted HTTP requests and reconciliation of proven durable receipts. Missing or invalid proof still blocks access, and existing quarantine still requires the documented recovery procedure. Bound original-primary operational recovery to an explicitly selected environment without changing account data or revoking legitimate sessions.
- Recorded deployment, browser, database and native simulator verification with their limits in [build status](docs/build-status.md). Local/intercepted browser checks are distinguished from real hosted acceptance and physical-device testing.
- Transferred repository administration to [`andyk/porchday`](https://github.com/andyk/porchday) and documented issue tracking, contribution checks and publication prerequisites. Selected GitHub private vulnerability reporting for publication and GitHub Support abuse reports for GitHub conduct, with their availability and coverage limits stated. Legal operator/branding details remain unconfirmed.

### Initial development — 2026-10-25

- Added the React/TypeScript PWA and SwiftUI iOS client, with a chronological feed, profiles, connection limits, groups, encrypted photos, threaded comments and multiple emoji reactions.
- Added invitation-based email/password accounts, verification/reset flows, MFA, device recovery, takeover reports and restricted staff review flows.
- Implemented shared OpenPGP content envelopes, JavaScript/native interoperability checks, local export/import, account deletion and inherited post/comment/media expiry.
- Added PostgreSQL migrations and restricted runtime roles, Cloudflare Worker/R2/Queue integration, cleanup jobs, independent restore journals and private media backup/restore tooling.
- Added optional browser/native push delivery, transactional email queues, an independent availability monitor, and aggregate latency/error/telemetry-loss alert logic with separate scoped credentials.
- Added Linux/database and macOS native simulator verification workflows, dependency notices, and operational documentation with explicit admission gates.

### Corrections and verification — 2026-10-25

- Tightened historical sharing, suspended-account access, profile/group photo removal, native expiry propagation and privacy-sensitive restore handling.
- Improved chronological feed query performance and recorded the scope of local measurements.
- Gave retried native photo uploads fresh media identities and added clear busy/retry feedback while preserving sequential uploads.
- Bounded encrypted-media parsing and upload concurrency, preserved failed-upload cleanup ownership, and exercised maximum-size synthetic uploads and backup/restore with isolated Cloudflare resources.
- Verified native simulator CI and local/database/runtime checks for the recorded revisions. Added separate monitoring readiness and sustained alert rules. The owner confirmed the deployed staging availability attention/recovery emails; performance and telemetry-loss notification delivery remain separate unverified checks.
- Added contribution, conduct, private security-reporting and branding policies. The current reporting routes and their limits are documented in those policies; legal operator and branding ownership remain unconfirmed.
- Added persistent selective posting/upload/invitation pauses that preserve authorized reads and account safety actions, with an incident-response runbook and regression checks.
- Documented the portable archive schema, version policy, synthetic standalone/multipart samples and importer interface. Added contract checks against the real ZIP and encryption implementations.
- Added the canonical integration API v1 address and consumer guide while preserving earlier aliases. Fixed bearer photo downloads to deny the photo's own deadline before storage reads, added per-grant read/token limits, and clarified that the export scope returns job status rather than archive bytes.

These entries describe implemented development work and scoped verification. The agreed MVP build and planned hosted acceptance are complete, but they do not establish public source availability, independent security review, nonprofit formation or broader pilot readiness. [docs/build-status.md](docs/build-status.md) records the evidence and remaining admission requirements.

## Release process

When an owner-authorized release is made, move the applicable unreleased entries into a dated version section and link its tag/release. Record member-visible changes, compatibility or migration requirements, security fixes safe to disclose, and known limitations. Retain unreleased work separately. Coordinate security disclosures through [SECURITY.md](SECURITY.md), and do not publish private reports, credentials or member data in release notes.
