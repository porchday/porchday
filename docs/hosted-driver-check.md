# Hosted database-driver regression

After the operator confirms a driver/configuration correction is deployed to staging, run:

```sh
npx tsx scripts/hosted-smoke.ts driver-check --run
```

This phase reuses existing verified synthetic members A and B, their original local encrypted keys, and the normal auth/social API. It never enrolls a device or changes a profile, password, connection, block or group. C is neither authenticated nor modified. Existing account fixtures remain intact.

Before any content mutation, an exclusive mode-0600 `artifacts/private/hosted-smoke/driver-check.intent.json` records all newly allocated post/photo/comment IDs, the expected synthetic JPEG hash and a ten-minute deadline. A prior intent stops the phase; there is no automatic replay or blind cleanup after an uncertain write. A partial run leaves only its new short-lived fixtures and private inspection references. Sessions are signed out in `finally`; successful evidence also requires old-session replay to be denied.

The bounded successful flow creates an A-only encrypted photo/post, a comment inheriting the exact deadline, and two independently encrypted reactions on both the post and comment. Repeating each reaction PUT verifies idempotence. A verifies signed decryption, exact text/deadline and the photo SHA-256. B gets 404 for post/photo reads and cannot decrypt A's ciphertext. The runner then deletes the parent once through the normal endpoint, verifies post/photo disappearance, checks the child-comment deletion endpoint reports 404, checks the feed no longer contains the new parent and confirms A/B identities remain accessible before logout.

A private result is written only after successful checks and session revocation. Terminal output contains fixed step/result labels only. This is a real hosted HTTP/crypto regression, not a browser UI or capacity test. API disappearance does not alone prove physical R2 erasure; that result stays explicitly false, with normal expiry/deletion outbox processing retained. The independent whole-account deletion check separately verifies delayed live-R2 cleanup.

At this checkpoint the phase has passed local execution-boundary tests and TypeScript checking but has not been run remotely. Record the deployed revision and actual result after authorization; do not turn local checks into a hosted success claim.
