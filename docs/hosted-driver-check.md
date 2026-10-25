# Hosted database-driver regression

After the operator confirms a driver/configuration correction is deployed to staging, run:

```sh
npx tsx scripts/hosted-smoke.ts driver-check --run
```

This phase reuses existing verified synthetic members A and B, their original local encrypted keys, and the normal auth/social API. It never enrolls a device or changes a profile, password, connection, block or group. C is neither authenticated nor modified. Existing account fixtures remain intact.

Before any content mutation, an exclusive mode-0600 `artifacts/private/hosted-smoke/driver-check.intent.json` records all newly allocated post/photo/comment IDs, the expected synthetic JPEG hash and a ten-minute deadline. A prior intent stops the phase; there is no automatic replay or blind cleanup after an uncertain write. A partial run leaves only its new short-lived fixtures and private inspection references. Sessions are signed out in `finally`; successful evidence also requires old-session replay to be denied.

The bounded successful flow creates an A-only encrypted photo/post, a comment inheriting the exact deadline, and two independently encrypted reactions on both the post and comment. Repeating each reaction PUT verifies idempotence. A verifies signed decryption, exact text/deadline and the photo SHA-256. B gets 404 for post/photo reads and cannot decrypt A's ciphertext. The runner then deletes the parent once through the normal endpoint, verifies post/photo disappearance, checks the child-comment deletion endpoint reports 404, checks the feed no longer contains the new parent and confirms A/B identities remain accessible before logout.

A private result is written only after successful checks and session revocation. Terminal output contains fixed step/result labels only. This is a real hosted HTTP/crypto regression, not a browser UI or capacity test. API disappearance does not alone prove physical R2 erasure; that result stays explicitly false, with normal expiry/deletion outbox processing retained. The independent whole-account deletion check separately verifies delayed live-R2 cleanup.

On October 25, 2026, the phase passed against staging revision **e1679d7**, Worker release **dd855f34-2dea-45ae-91f1-0cb112cd1d15**, after a matching healthy release check. It completed at **17:56:07.597 UTC**. All encrypted content/reaction checks, outsider denials, normal parent deletion/cascade/media denial, preserved A/B identities and post-logout session revocation passed. The private intent/result were retained; the runner did not repeat the phase or force physical cleanup.

This regression exercised the prepared-statement correction through actual hosted Hyperdrive/SQL and native R2 storage, using existing real synthetic sessions and signed encrypted payloads. C's independently verified account deletion had completed, leaving two surviving synthetic members. Subsequent feed timing uses that changed fixture and is not a strict comparison against the earlier three-member data set. Physical R2 erasure for this temporary driver fixture remains explicitly unverified by this phase.
