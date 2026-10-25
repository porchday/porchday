# Synthetic archive samples

Every identity, statement, relationship, group and date here is fictional. The 16 × 16 JPEG is a programmatically generated color gradient, with no camera, location, person or account metadata. The sample contains no account credential, private key, recovery secret or live service reference. Repository Apache-2.0 licensing covers these invented fixtures; it does not change the licensing of real members' content.

- `porchday-synthetic.zip` is a standalone plaintext archive. Its source `archive.json`, readable `index.html` and `photos/77777777-7777-4777-8777-777777777777.jpg` are also checked in for inspection.
- `multipart/porchday-synthetic-001.zip` and `002.zip` carry the same logical data as a two-part set. Part 1's post references a photo whose metadata/bytes are in part 2. The second part completes the set and supplies the aggregate HTML index.
- The sample was notionally exported on January 1, 2026. Its comment expired on January 2, 2026. Importing after that date must skip the comment, retaining the permanent post/photo and own reaction. The unavailable parent ID does not identify or include someone else's private comment.

The profile, one family connection and one group membership demonstrate metadata portability. Importing the sample must not contact the referenced account, join a group, assign a moderator role or publish anything. Only use a disposable destination account when exercising actual writes, and review any profile replacement first.

These are intentionally plaintext fixtures so reviewers can inspect them. Tests generate a random archive secret in memory, wrap the sample with the actual OpenPGP implementation, decrypt it byte-for-byte and reject a wrong secret. No example encrypted file with an embedded/deposited secret is presented as a secure backup.

Regenerate the ZIP/HTML files with `npx tsx scripts/build-archive-samples.ts`. It uses the real web `packArchive` implementation and normalizes only ZIP timestamps. The source JPEG was encoded with Go's standard `image/jpeg` encoder, quality 80, from a 16 × 16 RGB gradient `(80 + x*8, 80 + y*8, 120)`; the manifest checksums cover the committed bytes. The contract tests read these files directly and validate schema, multipart completeness, checksums, image dimensions, expiry and encryption round trips.
