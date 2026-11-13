# App Store preparation — November 13, 2026

Owner requested submission and public App Store release, for both supported Apple platforms. Tracked in #49 and #114. This record is preparation evidence, **not a submitted or approved release**.

## Apple state verified

- App `org.porchday.app`, App Store Connect app ID `6829621935`.
- iOS 0.1.0 (424), build `e3468e80-2f59-440a-997f-7f90c43f8b9d`, VALID and APP_STORE_ELIGIBLE.
- macOS 0.1.0 (410), build `2e1594df-80db-408c-a6c4-547f59277ae7`, VALID and APP_STORE_ELIGIBLE.
- Existing native source/test provenance: [November 11 release evidence](native-video-service-workers-2026-11-11.md), source `daf5369d0a63fecbcf8fccad43996d8dcac76960`. Physical-device acceptance remains unverified.
- Both existing store-version drafts now match the uploaded 0.1.0 version and reference the builds above. Release type is AFTER_APPROVAL. Fresh GET confirmed both remain PREPARE_FOR_SUBMISSION.
- App Store reviewer contact and dedicated demo sign-in/recovery instructions were created from the previously owner-authorized private TestFlight review details. Fresh GET confirmed the fields are populated. No credentials are included here. Current login and content recovery still need verification.
- Description, keywords and marketing URL saved and read back on both platforms. Copy discloses invitation-only membership, adult accounts, connectivity and recovery requirements; it does not claim independent security certification.
- Initial listing writes encountered connection timeouts. GET reconciliation showed the descriptions absent; subsequent IPv4-first requests saved them, followed by exact readback. No binary was uploaded again.

## Work still required before submission

- Actual app screenshots for required iPhone/iPad and Mac sizes, containing only authorized synthetic data.
- Complete age-rating questionnaire accurately, including user-generated content and social features; account policy is 18+.
- Complete and publish privacy labels based on actual service data flows, including optional diagnostics and builder chat. Encryption does not imply no data collection.
- Public support/privacy pages: current app routes require membership or an invitation, and help copy lacks a public support contact. Prepared change exposes only static `/privacy`, `/help`, `/contact` pages, retaining invitation-specific policy review and all member content gates. Contact publication awaits the owner's choice; earlier review-only contact details must not be published automatically.
- Resolve unfinished operator/rights-contact and retention disclosures in the pilot notice rather than claiming the placeholder policy is launch-ready.
- Verify store pricing, territory availability, copyright, categories, content-rights declarations and applicable account agreements. Availability lookup currently returns NOT_FOUND; no countries have been selected by this work. France export handling must not be inferred from the earlier beta-only decision.
- Browser access is disabled in Work settings. The owner was asked to enable it and sign in to App Store Connect for UI-only disclosures/account requirements.
- Stage and deploy any website changes through current release/native-parity gates; no web/API production changes were made by this preparation.
- Submit the completed release and verify Apple's returned review status. No review submission was attempted while required fields were absent.

Private one-shot intents and receipts live under the existing private Apple configuration directory with prefix `store-20261113-` / `store-audit-20261113-`. Do not copy reviewer data into issues, logs, screenshots or public store fields.

## Local checks

Web TypeScript check and four existing route tests passed after installing the exact lockfile dependencies in the isolated checkout. These checks do not establish hosted policy availability, screenshot acceptance or reviewer login. No build or test of a new Apple binary is claimed; the existing uploaded binaries were selected.
