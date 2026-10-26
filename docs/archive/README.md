# Porchday portable archive v1

This directory specifies the format already produced by the web and native iOS clients. It contains the [JSON Schema](archive-v1.schema.json), [version policy](version-policy.md), [importer interfaces](importer.ts), [importer guide](importer-guide.md), and a [fully synthetic sample](sample/README.md). These versioned resources travel with the source; they do not provide a hosted service or a supported SDK.

The manifest has `format: "porchday-archive"` and `version: 1`. The JSON Schema uses Draft 2020-12 and the identifier `urn:porchday:archive:v1`; the identifier is not a hosted schema URL. Validate formats as well as ordinary JSON types. The schema describes canonical producer output. Some current readers tolerate older or looser input, which does not expand this producer contract.

## Container and encryption

An unencrypted export is a ZIP containing UTF-8 `archive.json`, a readable `index.html`, and JPEG files under `photos/<uuid>.jpg`. ZIP storage and deflate are both used: native currently writes stored entries, and web uses deflate. HTML is a convenience view; JSON and image files are the migration source of truth. Web HTML includes post/comment/reaction text and photos; native HTML currently summarizes post/comment text. Full structured data remains in JSON in both clients.

By default each ZIP is encrypted locally into binary OpenPGP packets, conventionally named `.zip.pgp`. The member receives a separately generated 256-bit random secret encoded as 43 base64url characters. One independent archive secret protects all parts of that export set. It is not the account password, device recovery secret, or a device private key; losing it makes those encrypted downloads unreadable. Never include it in the ZIP, filename, URL, telemetry, or server request. Plaintext ZIP export requires an explicit warning/choice because anyone with the file can read it.

Use `encryptArchive` / `decryptArchive` from `@porchday/crypto`, or the native GopenPGP bridge, without changing their security configuration. The current producers use the RFC 9580 OpenPGP profile described in [the crypto protocol](../crypto-protocol.md), including authenticated encryption. Decryption with the correct secret detects corruption and changes made by someone who does not know that secret. **It does not sign the archive or prove the exporting member's identity, authorship, legal ownership, or timestamps.** Someone who knows the archive secret can create a different valid archive. Plain ZIP checksums and `sha256` fields likewise do not prove provenance; an editor can replace both a photo and its checksum.

The signed content envelopes used inside the service are decrypted before this portable format is written. Their original signatures, recipient keys and device-key backups are not part of `archive.json`. Imported source identifiers and timestamps are therefore provenance claims, not verified identities. The destination signs newly encrypted private content as the destination account. Do not label an imported source member as cryptographically verified.

## Manifest fields

| Field | Meaning |
| --- | --- |
| `generated_at` | Generation time for this part, in UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Parts need not have identical times. |
| `member_id`, `handle` | Source member UUID and handle. References do not grant access or establish identity at the destination. |
| `archive_set` | Optional multipart descriptor; omission is the supported standalone format. |
| `profile` | Decrypted profile payload, including theme/personalization; object or `null`. At most one non-null profile in a set. |
| `posts`, `comments`, `reactions` | Only this member's contributions. All arrays exist even when empty. Post and comment reactions share the `reactions` array. |
| `media` | This member's photo metadata; the matching JPEG must be in the same ZIP as its metadata. |
| `connections` | `{member_id, kind}` references, with `kind` equal to `friend` or `family`; not invitations or contact details. |
| `groups` | `{group_id, role}` references, with `role` equal to `owner`, `moderator` or `member`; not group history or transferable permissions. |

An authored entry contains `id`, `created_at`, `expires_at`, `audience`, `parent_id`, `group_id`, and a decrypted `payload` object. `expires_at: null` means no deadline; otherwise it records the effective original deadline, including any ancestor's shorter deadline. Keep that deadline when migrating. A comment or reaction can refer to an unavailable parent UUID; the archive does not supply someone else's private content to explain it. `parent_id` is context, not permission to fetch or reconstruct that parent. The v1 reaction entry does not separately encode the target's post/comment type; do not infer an unavailable thread from it.

Payloads preserve application fields instead of flattening them to text. Common fields include `text`, `media`, `emoji`, and `provenance`. `emoji` is a reaction catalog identifier such as `like`. `payload.media` references photo UUIDs; profile `avatar`, `cover`, and `background` use the same reference shape. The optional `reactionSecret` is a content-local reaction-tag seed, not a login or recovery credential. Current clients can export it as part of the original payload and generate a fresh seed on import. Treat it as private data and do not reuse it for destination reactions.

Photo metadata includes `path`, `mime: "image/jpeg"`, alt text, dimensions, a lowercase SHA-256 of the exact JPEG bytes, original creation/expiry times, and nullable `post_id`, `profile_id`, `group_id`, and `slot`. `slot` is `avatar`, `cover`, `background`, `image`, or `null`. `name` is optional: web writes it; native currently does not. A group image can belong to the exporting member even though the group itself is not recreated. Its bytes must not be silently discarded.

The v1 wire shape carries UUIDs for ordinary exported object identities. Dates use the canonical UTC form above. The original `created_at` and effective `expires_at` are retained for imported authored records. Profile revision/creation metadata is destination-specific. A destination may re-encode imported images for safety, so its new image checksum can differ from the archived source checksum.

## Multipart exports

Each part is independently readable as a ZIP and, by default, independently encrypted with the set's shared archive secret. Its manifest carries:

```json
{"archive_set":{"id":"99999999-9999-4999-8999-999999999999","index":1,"total":null}}
```

Indices start at 1. Earlier parts have `total: null` and `complete` absent or false. The final part has `index: N`, `total: N`, and `complete: true`; it may contain only the completion marker and otherwise empty sections. Streaming export does not know `N` in advance. Each part also contains `archive-part-NNN.json` and `index-part-NNN.html`, with at least three digits. The final part supplies an aggregate `index.html` linking the numbered HTML files.

Select each original ZIP/PGP file for import. Require exactly one complete part, one set ID, one member ID, unique contiguous indices `1..N`, and a completion index equal to `N`. Photo references may cross parts, but a photo's metadata and JPEG must be together. Require unique photo IDs, no repeated `(section, entry ID)` records, at most one profile, and all referenced photo IDs present across the set. A non-null early `total`, duplicate completion, missing part, or mixed-member set is not canonical v1. Some current reader checks are less strict than this complete adapter validation procedure; schema validation alone is not enough.

For reading offline, extract all parts into one directory and open the final `index.html`. Each ZIP has its own `archive.json`, so extraction may overwrite that filename. The numbered JSON files preserve every part; do not import the one overwritten `archive.json` as if it were the complete export.

## Bounds and validation

All sizes below are binary MiB (`1,048,576` bytes). These are per-part safeguards, not an account-size entitlement. Current exporters target 20 MiB of estimated content per part and split progressively.

| Check | Web | Native iOS / interoperable adapter limit |
| --- | --- | --- |
| Input selected encrypted file | 31 MiB | 31 MiB |
| Decrypted ZIP | 30 MiB | 30 MiB |
| Total expanded ZIP entries | 35 MiB | 30 MiB |
| `archive.json` | 8 MiB | No separate native cap; use 8 MiB for compatibility |
| ZIP entry count | 5,000 | 5,000 |
| Selected multipart files | No explicit count cap in web | 1,000 |
| JPEG bytes / dimensions | 20 MiB; each dimension at most 2,400 | Same interoperable bounds |
| Text / photos per authored payload | 5,000 UTF-16 code units / 10 | Use the same bounds for cross-client import |

The schema's `maxLength` counts Unicode code points; additionally enforce the web client's 5,000 UTF-16-code-unit text limit when producing compatible archives. The schema cannot check ZIP expansion, file checksums, image decoding, path equality, current time, cross-part completeness, duplicates by identity, or permission. A robust importer must perform those checks too. Use bounded decoding, reject duplicate ZIP paths, absolute paths, `..`, backslashes, symlinks, directory entries and unexpected executable content. Allow only the documented JSON/HTML/JPEG paths. Validate `path === "photos/" + id + ".jpg"`, hash the actual bytes, validate image headers before invoking a decoder, and check decoded dimensions. Never execute archive HTML or embedded profile code during import.

Export packaging/encryption happens before the final server ownership/expiry check for that part; a failed check cancels the save. A later expiry cannot recall a file already downloaded. Recheck deadlines at preview, before uploading a photo, and before saving an imported record. Skip expired records/photos and preserve the earliest media/parent deadline. No import may convert a timed item into permanent content. Do not load every photo in a large archive set into memory at once.

## Privacy, rights and release status

An ordinary member export excludes account passwords, sessions, OAuth tokens, recovery tokens, private keys, moderation evidence, other people's private contributions and private contact details. It can contain personal information the member themselves wrote into their own content. A structural schema cannot discover or redact all such information. Unknown fields are data, never instructions or executable code; inspect unsupported fields before forwarding them to another platform.

The application's Apache-2.0 source-code license is not a license grant over members' photos or writing. Exporting, possessing, decrypting, or importing an archive does not itself establish a right to publish someone else's material. The included fixtures are invented for this repository and licensed with its Apache-2.0 code; they do not represent a real member or grant access to any service. Service terms and any future public release require their own review. This format description does not claim that review has happened.

Migration currently means the implemented Porchday web/iOS private importer or a local converter consuming these files. No external-platform upload adapter, federation protocol, public schema host, or package registry release is implemented by these documents. Repository visibility remains private until the owner explicitly authorizes publication.

## Implementation and checks

- Web: [archive container](../../apps/web/src/archive.ts), [export/import UI](../../apps/web/src/DataTransfer.tsx), [photo validation](../../apps/web/src/photo-safety.ts).
- Native: [PortableArchive.swift](../../apps/ios/Porchday/PortableArchive.swift), [crypto bridge](../../packages/crypto/native/porchcrypto.go).
- Server: [export routes](../../apps/api/src/social-exports.ts), [private import route](../../apps/api/src/social.ts).
- Contract tests: [archive-contract.test.ts](../../scripts/archive-contract.test.ts). Run `npx vitest run scripts/archive-contract.test.ts`; typecheck the interfaces with `npx tsc -p docs/archive/tsconfig.json`.

These tests validate the schema and sample against the real web ZIP/crypto code. Existing native crypto interoperability and simulator tests are separate evidence; the documentation tests are not a new native end-to-end migration or a third-party compatibility certification.

## Custom emoji collections and reactions

Version 1 optionally includes `emojiLibrary: {customEmojis: [...]}` in one archive part. This is the decrypted personal collection, separate from the profile; absent/null means no exported collection. Each custom descriptor contains `emoji: "c1_<SHA256>"` and `custom: {name, png}`. The digest covers the exact normalized static PNG bytes, encoded with standard base64. Validate the digest, PNG structure and decoder result, 128×128 dimension/32 KiB bounds, lowercase ASCII name, and48-item collection cap before reuse. Import merges by canonical image identity and encrypts a new owner-only collection for the destination. Existing reactions keep their own image copy when a saved collection item is removed.

Unicode descriptors use `emoji: "u1_<SHA256>"` plus `unicode`; the digest covers the canonical fully-qualified Unicode UTF-8 sequence. The original six IDs remain unchanged. Reaction entry IDs are43-character keyed tags, rather than post/comment UUIDs. Reaction images and labels remain inside the encrypted parent-audience envelope in the service; they are plaintext only after local archive decryption. Saved copies and copies reused by other authorized readers cannot be remotely recalled.
