# Changelog

This file records notable development changes. Porchday has no published GitHub release or release tag as of 2026-10-25. The package version `0.1.0` is development metadata, not an announcement of a supported release. The repository remains private.

## Unreleased

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
- Added contribution, conduct, private security-reporting and branding policies. A verified restricted reporting contact, independent conduct contact and branding-rights ownership record remain launch gates.
- Added persistent selective posting/upload/invitation pauses that preserve authorized reads and account safety actions, with an incident-response runbook and regression checks.
- Documented the portable archive schema, version policy, synthetic standalone/multipart samples and importer interface. Added contract checks against the real ZIP and encryption implementations.
- Added the canonical integration API v1 address and consumer guide while preserving earlier aliases. Fixed bearer photo downloads to deny the photo's own deadline before storage reads, added per-grant read/token limits, and clarified that the export scope returns job status rather than archive bytes.

These entries describe implemented development work and scoped verification, not a completed hosted service, public release, security audit or nonprofit formation. [docs/build-status.md](docs/build-status.md) records exact evidence and remaining deployment, review and operational prerequisites.

## Release process

When an owner-authorized release is made, move the applicable unreleased entries into a dated version section and link its tag/release. Record member-visible changes, compatibility or migration requirements, security fixes safe to disclose, and known limitations. Retain unreleased work separately. Coordinate security disclosures through [SECURITY.md](SECURITY.md), and do not publish private reports, credentials or member data in release notes.
