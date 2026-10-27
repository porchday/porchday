# Per-connection history sharing

Status: web/API deployed to staging and production on October 26, 2026; native source passes simulator CI. The reported member-to-member wall check remains `needs verification` in [issue #22](https://github.com/porchday/porchday/issues/22). This document is not evidence that a particular member's posts have finished sharing.

## Member choice

When sending or accepting a friend/family request, each member chooses how to share their own posts:

- **Share full history (recommended)** is the default displayed by the updated clients.
- **Only share new posts** leaves earlier posts outside that new connection's audience.

The choices are independent. Selecting full history for someone allows that person to receive your eligible earlier posts; it does not select how they share with you. Sending a request records a preference but grants no access until it is accepted.

Connections also provides a history-sharing setting for an existing connection. Existing connections and requests from older clients retain future-only behavior until their author opts in. Missing API fields are treated as future-only; the updated UI explicitly submits its chosen value. Changing full history to future-only stops further catch-up and does not take back posts already shared. Removing or blocking a connection still revokes current service access; a later friendship requires new choices and fresh grants.

“Full history” means live posts on that author's wall whose selected audience currently includes the other person. It does not include Only me posts, expired/deleted content, family-only posts shared with a friend, friends-only posts shared with family, or posts in groups they cannot access. Group history is a separate policy.

## Encrypted catch-up

An earlier post was encrypted for its original devices. Adding a database permission cannot make a new friend decrypt it, and modifying its signed recipient list would invalidate its signature. The author must have an unlocked device with the necessary historical keys. Catch-up runs in bounded batches while that client is available and resumes after unlock or returning online. Saving the preference is distinct from completing encryption and delivery.

The author client reads and verifies its own original post and owned photos. It uses a fresh, narrowly authorized audience snapshot to create a new version-1 signed encrypted revision. That snapshot combines still-eligible existing recipients with currently eligible connections for which the author selected full history; it does not add all current friends indiscriminately. Directory or relationship changes require a fresh snapshot.

The post keeps its ID, creation time, audience, parent and absolute expiry. Its revision advances, but its feed position does not. Photos receive fresh immutable IDs and ciphertext; the client updates its own post's encrypted photo references. The API atomically commits the new post envelope, recipient grants and replacement attachments, and schedules the old owned photo objects for the existing deletion process. The operation does not copy or delete the whole post/thread and does not restart a timeout.

Before accepting a refresh, the server checks the source revision, exact source deadline and attachment set, current author/device, history preference and current permissions. The refreshed recipient set and media must agree. A stale edit, expiry, unfriend, block or restrictive policy change must not commit new access. An uncertain write is resolved by reading current state; clients must not delete media that may have become attached in a successful but unacknowledged transaction.

The existing OpenPGP format and verification rules stay in force. No server decryption key, new encryption primitive or unsigned recipient-list modification is introduced. Database, storage and network metadata remain subject to the existing limitations in the [crypto protocol](crypto-protocol.md).

## Comments, reactions and other boundaries

Full history currently applies to the selecting member's wall posts and owned photos. Earlier comments and reactions keep their original recipients, including contributions from the post author. A wall owner cannot re-sign another person's contribution. Newly admitted readers receive only historical contributions already addressed to them, with inaccessible comment ancestors and their descendants excluded. Future comments/reactions use the newly authorized parent audience under the existing rules. Redistribution of older contributions requires a separate contributor-authorized design.

Profile and group sharing retain their existing controls. “Share as a new post” remains a separate deliberate copy, with a new post identity and no copied comments/reactions. Members' exported copies, screenshots and already received keys cannot be recalled by changing a history preference, removing a friendship or deleting server data.

## Recovery and verification

Restrictive history-policy changes participate in privacy-journal handling. Replaying a backup must not restore an old full-history preference that can silently recreate access. A conservative restored relationship removal is acceptable when the journal cannot safely preserve the newer restriction. Pending uploads, old attachment cleanup, account deletion and expiration continue to use their existing retention and recovery rules.

Required evidence covers both choices in both directions, default handling on old/new clients, an existing friendship opting in, exact post identity/date/deadline preservation, encrypted photos, unrelated future-only recipients, Only me and audience exclusions, old foreign-authored contributions, concurrent edits/devices, stale epochs, lost responses, block/removal, restrictive-policy replay, and a bounded retry after the author returns online. Local/API and synthetic browser checks do not establish that a real member's keys were unlocked or that every historical post has finished sharing. Record hosted and member acceptance separately in issue #22.

Local verification for this implementation passed 20 crypto tests and 606 application/script tests against disposable PostgreSQL, plus workspace TypeScript checks and the web production build. CI for implementation commit `eecf3f7` passed application verification, secret scanning and the native Xcode/simulator suite. Fresh Chromium fixture checks at 1280, 375 and 320 pixels verified the choices and submitted values; these use synthetic API responses and are not hosted acceptance. Physical-device and member acceptance remain separate.

The final application source is `c30f169cbe687ff4a3f46d56b4ee00319868c1fd`; its application CI and secret scan also passed. Migration `046_connection_history.sql` was applied and verified in both environments, including runtime permissions and restrictive-choice journaling. Staging version `7dbf1229-fc68-4e09-aba9-5af1aef5efbb` passed a real encrypted post/JPEG test with synthetic accounts: future-only denial, full-history opt-in, successful recipient decryption, preserved dates and both deadlines, retry, and full-to-future retaining previously delivered access. Cleanup removed the test content/relationship, restored the fixture's original blocks, and revoked the test sessions.

Production version `9c12c603-5ab7-40dc-a47b-551ff8fea197` serves the same reviewed API and web assets. Protected health is healthy at both production origins. Fresh signed-out Chromium checks verified the homepage, login, available signup form and `.com` redirect over normal HTTPS. Signup, queue settings and existing provider policy were preserved. Native simulator evidence does not establish physical-device acceptance.

Known follow-ups: photo replacement temporarily needs additional storage quota and large-history candidate selection needs a scale benchmark and bounded database scan ([issue #9](https://github.com/porchday/porchday/issues/9)); the portable connection list does not yet include the new directional sharing preferences ([issue #23](https://github.com/porchday/porchday/issues/23)). Import must still require fresh mutual acceptance and must never silently recreate old sharing permissions.
