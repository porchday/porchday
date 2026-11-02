# Shared native Apple parity

Owner request November 1, 2026: bring the existing iOS app into compatibility
with the current web member experience, share it with native macOS, and retire
the Mac WebKit wrapper. Track delivery in #49 and #114. Bundle: org.porchday.app.
Baseline web source: c658f1f. Proposed but unimplemented web roadmap features are
not silently treated as deployed contracts. Full parity is not yet verified.

| Area | Existing native state | Required acceptance |
| --- | --- | --- |
| Auth, recovery, encrypted feed/comments, reactions, groups, profiles | Implemented | Cross-client round trips and current simulator/Mac checks |
| Invitations, friend/family, expiry and history sharing | Implemented | Retain consent, revocation and reader floors |
| Photos calendar, filters, highlights, day navigation | Missing | Same authorized calendar API and personal selections; expiry and pagination |
| Video | Missing | Existing encrypted MP4/MOV/WebM contract, safe playback, bounded selection; archive compatibility |
| People and children | Missing | Stable encrypted tags, parent-only birthdays, delegated posting, no audience expansion |
| Security, integrations, appeals | Browser handoffs | Native forms and existing authorization/recent-auth rules |
| Builder chat/feature board | Previously postponed | Review current access model and native implementation under this owner request |
| Native macOS | Wrapper only | Shared SwiftUI target, native media/files, Keychain, sandbox and hardware acceptance |
| Distribution | No processed build yet | Exact-source CI, signing, privacy/export declarations, TestFlight and device checks |

Wrapper retirement removes current source and packaging, not installed browser
storage or historic evidence. An installed preview must retain its local data
until the member verifies native recovery. Native identity does not transfer
browser encryption keys automatically. No backend or website deployment is
required for client implementation alone.
