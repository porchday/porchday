# Crypto package integration

Import browser-safe primitives from `@porchday/crypto` and optional IndexedDB helpers from `@porchday/crypto/browser`. These functions use WebCrypto and require a secure browser context.

| Function | Input/output | Caller responsibility |
|---|---|---|
| `generateDeviceKeys(memberId, deviceId, recoverySecret?)` | Public key, protected private armor, fingerprint, random recovery secret | Generate on client; never upload returned secret; use a separate recovery signing identity. |
| `unlockPrivateKey(armor, secret, expectedFingerprint?)` | In-memory OpenPGP private key | Pass pinned fingerprint; never send unlocked key/secret to API. |
| `encryptObject({context,payload,signingKey,recipients})` | Full `EncryptedEnvelope` | Verify/pin recipient public keys; fresh audience epoch; self signer included. |
| `decryptObject({envelope,expectedContext,privateKey,authorPublicKey,now?})` | Verified payload | Supply independently requested resource context and pinned author key; enforce current API authorization. |
| `authorizeDevice(statement,trustedKey)` | `{statement,signature}` | Use exact server-issued challenge/expiry; new fingerprint binds requested key. |
| `verifyDeviceAuthorization(proof,trustedPublicKey,expected,now?)` | Verified statement or rejection | Verify trusted key ownership/revocation; atomically consume challenge. |
| `signStatement` / `verifyStatement` | Detached OpenPGP signature | Define purpose, nonce, expiry, domain, field validation and replay rules per use. |
| `createRecoverySecret` / `createReactionSecret` | Random 43-character base64url secret | Keep secret out of routing metadata, logs and API plaintext. |
| `reactionTag({secret,targetId,memberId,emoji})` | 43-character opaque MAC tag | Store secret inside target payload; recompute tags after decrypting reactions. |
| `encryptArchive(bytes,secret?)` | `{ciphertext,secret}` | Export only member-owned authorized data; split above 30 MiB. |
| `decryptArchive(ciphertext,secret)` | Verified bytes | Validate schema/checksums/expiry/provenance before import. |
| `fingerprint` / `displayFingerprint` | Verified key fingerprint / grouped display | Pin keys and let members compare fingerprints through another channel. |
| `rememberDevice(meta,key)` / `recallDevice(meta)` | Locally protected key / unlocked key | Explicit private-device choice; no hardware-security claim. |
| `forgetDevice(meta)` / `forgetAllDevices()` | Remove local key persistence | Call on logout, shared-device cleanup, and relevant revocation. |

Context, recipient and device-authorization TypeScript interfaces are exported from `packages/crypto/src/index.ts`. Preserve exact context types and canonical millisecond UTC dates. Pass JSON data only. Treat decryption errors as an unavailable/failed-verification item; never render the unverified body or offer plaintext fallback.

Photo payloads may carry base64 bytes plus MIME type, dimensions, and digest. The package treats these as opaque JSON; it does not decode, resize, strip EXIF, or validate image content. Do that on the client before upload and after decryption under bounded image limits.

Run `npm run test -w @porchday/crypto` and `npm run typecheck -w @porchday/crypto`. The package test runner is Node's built-in runner; exclude these tests from a separate Vitest collection.
