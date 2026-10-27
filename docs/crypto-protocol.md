# Porchday encrypted content, version 1

Status: implemented building block; independent application/protocol review is required before real member enrollment. This document describes the cryptography package and the surrounding application obligations. Passing package tests does not prove the complete service enforces those obligations.

## Protocol and libraries

Porchday uses standard OpenPGP packets from RFC 9580, implemented by OpenPGP.js 6.3.2 in the browser and GopenPGP 3.5.0 in the native bridge. Content encryption uses v6 Curve25519 encryption/Ed25519 signing keys and AES-256 with OpenPGP authenticated encryption. The JavaScript implementation selects AES-GCM and requires a v2 integrity-protected packet before decryption. Each publication generates a fresh OpenPGP session key; the library encapsulates it for each explicit recipient device. The application does not implement curve math, key exchange, signatures, or OpenPGP packet encryption.

MLS was evaluated. It provides forward secrecy and post-compromise security for continuously evolving groups, but requires ordered epoch transitions, retained client group state, and application-specific recovery and per-wall audience rules. For the pilot, independently encrypted, signed OpenPGP objects fit asynchronous readers and explicit per-post audiences without inventing a group ratchet. **This design does not provide forward secrecy or automatic post-compromise security.** A copied private key can decrypt previously obtained ciphertext addressed to that key. Revocation excludes the device from future objects and blocks server access; it cannot recall copied keys. MLS remains a possible separately reviewed migration, not a claimed feature.

References: [OpenPGP RFC 9580](https://www.rfc-editor.org/rfc/rfc9580), [OpenPGP.js documentation](https://docs.openpgpjs.org/), [OpenPGP.js AEAD support](https://github.com/openpgpjs/openpgpjs#aead-support), [GopenPGP](https://github.com/ProtonMail/gopenpgp), [MLS RFC 9420](https://www.rfc-editor.org/rfc/rfc9420), [MLS architecture RFC 9750](https://www.rfc-editor.org/rfc/rfc9750).

The application is Apache-2.0. OpenPGP.js is a separate LGPL-3.0-or-later dependency; GopenPGP is MIT. Preserve their license notices and offer the exact dependency source/relinking materials with distributions. No claim is made that an upstream library audit covers Porchday's code, composition, build, or deployment.

## Wire format and signed binding

An encrypted object is JSON:

```json
{
  "v": 1,
  "protocol": "porchday-openpgp-v1",
  "context": {
    "id": "client-generated-uuid",
    "kind": "post",
    "authorId": "member-uuid",
    "authorDeviceId": "device-uuid",
    "audience": "connections",
    "parentId": null,
    "groupId": null,
    "epoch": 12,
    "createdAt": "2026-10-25T00:00:00.000Z",
    "expiresAt": null,
    "revision": 1
  },
  "recipients": [
    {"memberId": "member-uuid", "deviceId": "device-uuid", "fingerprint": "v6-key-fingerprint"}
  ],
  "ciphertext": "-----BEGIN PGP MESSAGE-----..."
}
```

`ciphertext` decrypts to JSON containing exactly the same `v`, `protocol`, `context`, and `recipients`, plus `payload`. The whole plaintext is signed by the author's device before encryption. Readers require one valid signature from the pinned author public key and compare every outer binding field to the signed inner copy. A caller must also supply the context of the resource it requested, rather than trusting an envelope's self-description. Object, parent, audience, epoch, expiry, and revision substitutions therefore fail verification. Extra unrecognized binding fields fail closed.

Recipient arrays are sorted by device ID and contain no duplicate device ID. The signing device must be included as a recipient. A recipient reference binds member, device, and fingerprint; callers must verify member/device directory relationships and trust before encryption. A valid signature proves possession of a key, not a human identity or an authorized relationship.

Kinds are `post`, `comment`, `reaction`, `profile`, `group`, `media`, `report`, and `export`. Audiences are `connections`, `family`, `only_me`, `group`, and `moderators`. IDs are bounded ASCII tokens. Dates use canonical UTC ISO strings including milliseconds. Revision is a positive integer; epoch is a nonnegative integer. The server enforces uniqueness of resource IDs and monotonic revisions. Clients reject expired content even if ciphertext was already fetched. Network authorization still takes precedence over successful decryption.

The current directory epoch is returned with a publication audience. The service atomically checks that epoch and the exact currently eligible device set when accepting the object. A stale snapshot causes a retry and fresh encryption, never plaintext or silent recipient omission. Every object uses independent session keys, so there is no old shared group encryption key to leak after membership changes. Parent replies use current trusted devices of the parent's historical member audience, intersected with current permissions and blocks. A newly authorized device can receive future replies; this does not grant decryption of the unchanged parent ciphertext. An author can choose full-history sharing for a personal connection, authorizing their unlocked client to re-encrypt earlier eligible posts/photos. Each direction has its own consent; future-only connections and new group members do not acquire missing historical grants. The server validates a history-specific recipient snapshot rather than blindly including every current friend. The original signed recipient list is never edited in place. See [friend-history sharing](friend-history-sharing.md). A new device can access old objects only by restoring a member-held historical device key or obtaining explicit authorized redistribution. The server cannot manufacture that access.

Encrypted content has a 30 MiB plaintext ceiling, a 44 MiB ASCII ciphertext ceiling, a 4,000-device cryptographic ceiling, no compression on generation, and a bounded decompression limit on reading. These are safety limits, not recommended group or photo product limits. The API must impose smaller feature-specific limits. Photo variants are independently encrypted, with photo bytes represented as base64 inside signed JSON alongside MIME type, dimensions, checksums, and context. Client image validation, EXIF stripping, safe decoding, and resource limits remain essential.

## Devices, trusted keys, and recovery

Initial onboarding generates an ordinary device key and a separate recovery-only signing key. Both private-key backups are OpenPGP-protected with a randomly generated 256-bit recovery secret independent of the login password. Store public keys and encrypted backups on the service; display the recovery secret only to the member. Do not send the secret to the service or put it in URLs, telemetry, localStorage, or service-worker caches. The recovery key must not remain unlocked on an ordinary device. Keeping it separate prevents a revoked ordinary device key alone from becoming a permanent recovery credential.

Only the first-ever device may use initial enrollment. Later additions require a detached OpenPGP signature made either by a current trusted device or by the dedicated recovery key, over:

```json
{
  "v": 1,
  "purpose": "porchday-device-authorization",
  "memberId": "member-uuid",
  "authorizingDeviceId": "trusted-device-uuid-or-recovery",
  "deviceId": "new-device-uuid",
  "fingerprint": "new-v6-key-fingerprint",
  "challenge": "server-generated-one-time-challenge",
  "expiresAt": "2026-10-25T00:10:00.000Z"
}
```

The server issues a random, single-use challenge scoped to the authenticated member and proposed device/fingerprint. It verifies proof using the current trusted device key or registered recovery public key, checks all fields, and consumes the challenge in the same transaction as enrollment. The proof expires within 15 minutes. Password reset, email access, staff action, or a valid login session alone must not authorize encryption devices. Recovery-key replacement requires the existing recovery key or a carefully disclosed reset that abandons historical keys and visibly changes the account identity; it cannot silently replace the trust root.

A recovery process restores old device keys from encrypted backups for reading historical ciphertext and creates a fresh device key for future publications. It must revoke stolen sessions/devices, prevent stale audience writes, and warn that previously copied keys and content remain exposed. Losing every trusted device and the recovery secret means historical content cannot be recovered by support.

Clients pin first-seen identity/device fingerprints, show safety fingerprints for out-of-band comparison, and require explicit confirmation for unexplained key changes. Signed device continuity does not replace a trustworthy initial comparison. The pilot has no independent key-transparency witness; malicious server substitution at first contact remains a documented threat. More fundamentally, a malicious operator can serve altered PWA code. No claim of protection against malicious releases, compromised endpoints, or unverified initial identity is made.

Optional remembered-browser storage uses a randomly generated, nonextractable AES-GCM CryptoKey in IndexedDB to protect unlocked private armor. The encrypted bytes bind member, device, and fingerprint as additional authenticated data, with a fresh 96-bit IV. This is local protection against accidental raw key storage, not hardware isolation or defense against same-origin JavaScript. Remembering requires an explicit private-device choice. Sign-out, local revocation, and shared-device cleanup delete it. Browser eviction can remove it; the member must retain their recovery secret. Native keys must be kept in device-only Keychain storage and never application logs.

## Reactions and lifecycle changes

Each post/comment payload includes a fresh random 256-bit `reactionSecret`. It is encrypted with the content and is never an outer field. Reaction choice ciphertext contains its canonical emoji ID. The server deduplication tag is standard HMAC-SHA-256 keyed by that secret, over sorted-key JSON:

```json
{"emoji":"like","memberId":"member-uuid","purpose":"porchday-reaction-v1","targetId":"target-uuid"}
```

The 32-byte digest is base64url without padding. A member can publish distinct tags for different emoji on the same target. Tags do not reveal emoji through a public dictionary hash and are isolated across member and target. The server still learns target, reacting member, timestamps, ciphertext size, and repeated use of a tag. Authorized audience members know the secret and can interpret choices; that is intended. A malicious client can submit inconsistent tags, so clients must recompute after decryption, reject mismatches, and avoid counting duplicate canonical emoji from the same member. This application use of a standard MAC and key-lifecycle behavior needs independent review.

Edits and timeout shortening re-sign a complete new envelope revision with the original immutable object identity, a non-extended expiry, and a fresh allowed audience snapshot. Alternatively a service can use the package's detached statement primitive for a strictly specified lifecycle update; arbitrary unsigned outer expiry changes are forbidden. Parent expiry is always an upper bound for replies. The UI warning and server cascade remain necessary. Deleting server ciphertext or refusing decryption after expiry cannot erase another member's screenshots, exports, or previously saved keys.

## Exports, reports, and exclusions

Portable encrypted export files use standard password-encrypted OpenPGP with a separately displayed random 256-bit archive secret and authenticated encryption. They are independent of destination account keys. Current package exports are limited to 30 MiB per part; the export application must partition larger archives and provide a manifest/checksums. Archives must exclude credentials, recovery/device keys, moderation evidence, and others' private contributions. Plaintext exports require an explicit member choice and warning. Import decrypts on the client, validates schema/checksums/expiry/provenance, and re-encrypts for private destination audiences.

Reports are ordinary signed encrypted objects addressed to explicitly selected moderation public keys plus the reporter. A reporting UI previews exactly the evidence being disclosed. Staff do not receive an ambient social-content key. Email, push, logs, crash reports, and observability contain no content, private keys, recovery secrets, or sensitive URL tokens.

The service necessarily processes login identifiers, hashes, public handles/keys, social routing and group memberships, roles, ciphertext size, object IDs, timestamps, expiration, delivery state, and minimal security logs. These are metadata exceptions, not E2EE social content. The public website is public. A recipient can disclose content. Infrastructure encryption-at-rest and TLS are additional protections.

## Verification and launch gate

Package tests exercise recipient-only decryption, wrong authors, unsigned messages, ciphertext tampering, signed context/recipient substitutions, independent recovery, exact fresh device authorizations, signed lifecycle changes, expiry, exclusion of departed devices, multiple-reaction tags, archive corruption, and a real 301-device audience. A desktop test measured roughly 130 ms encryption and 10 ms decryption for one recipient, with roughly 105 KiB armored ciphertext; this does not substitute for mobile testing.

Shared fixtures under `packages/crypto/test/fixtures` contain deliberately public synthetic keys and must never be used for live accounts. Interoperability checks must verify OpenPGP.js to GopenPGP and the reverse, including signature verification and context checks, before the iOS app claims compatibility.

Before real pilot enrollment, obtain independent cryptographic/application review covering recipient-directory authentication, device/recovery lifecycle, browser key storage, proof replay, epoch races, sender validation, reaction-tag composition, archive handling, moderation disclosure, dependency provenance, and native/Web interoperability. Also verify deployed authorization, negative access paths, no plaintext in observability/storage, account recovery, deletion cascades, photo decoding/resource limits, revoked-device behavior, client expiry timers, PWA cache contents, and mobile performance. An independent review has not happened merely because these tests pass.
