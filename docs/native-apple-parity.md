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
| Photos calendar, filters, highlights, day navigation | Implemented; acceptance pending | Same authorized calendar API and personal selections; expiry and pagination |
| Video | Implemented; acceptance pending | Existing encrypted MP4/MOV/WebM contract, safe playback, bounded selection; archive compatibility |
| People and children | Implemented; acceptance pending | Stable encrypted tags, parent-only birthdays, delegated posting, no audience expansion |
| Security, integrations, appeals | Native forms implemented | Native forms and existing authorization/recent-auth rules |
| Builder chat/feature board | Native allowlisted screens implemented | Review current access model and native implementation under this owner request |
| Native macOS | Shared native target compiles; wrapper retired | Shared SwiftUI target, native media/files, Keychain, sandbox and hardware acceptance |
| Distribution | No processed build yet | Exact-source CI, signing, privacy/export declarations, TestFlight and device checks |

Wrapper retirement removes current source and packaging, not installed browser
storage or historic evidence. An installed preview must retain its local data
until the member verifies native recovery. Native identity does not transfer
browser encryption keys automatically. No backend or website deployment is
required for client implementation alone.

Implementation commits: 238ef75 shared Mac, f6e95ce calendar/children/video,
22683a6 account controls/archives, 55c1e82 builder/feature views, 2ca7812 native
Mac sidebar/media lifecycle, f1af5a3 typed mentions/caption editing. These are
source milestones, not release acceptance. Shared calendar/tag/media contract
checks run on Mac as well as iOS; current exact-source CI remains required.

On the previous Xcode 26.3 run, the app/test bundles compiled but simulator tests
never started before cancellation. That incomplete evidence is not a pass. The
workflow now preboots the newest installed iOS 26 runtime with a five-minute
readiness bound and disables cloned parallel test runners. Owner requested
expanded scope supersedes that old distribution candidate; no upload occurred.

Latest audit found AVFoundation-only WebM playback was not sufficient. A local,
ephemeral WebKit codec surface now handles WebM under a deny-network CSP without
any hosted app UI or native message bridge. Native AVKit handles MP4/MOV.
A generated solid-color VP9 fixture tests actual decoding, dimensions and poster
extraction on both platform test targets. iOS minimum is 17.4. Day views now
re-evaluate expiry each second, including selectable featured attachments.
