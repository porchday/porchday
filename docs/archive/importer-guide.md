# Implementing a local archive importer

The supported destination today is Porchday's dedicated private-import workflow in the web and native iOS clients. A local converter can consume the documented JSON/JPEG files for another platform, but no external-platform adapter or federation feature is implemented. Preserve a readable source copy and explain unsupported fields before offering a conversion. The [TypeScript interfaces](importer.ts) describe the data and existing API bodies; they are documentation, not a new client SDK or a promise that the apps implement the optional `LocalArchiveReader` abstraction.

## Read and preview on the member's device

1. Accept a single standalone archive or every original part of one set. Keep input bounded. If encrypted, ask for the independently generated archive secret and call `decryptArchive`. Never upload that secret or the decrypted ZIP. Apply the [container limits](README.md#bounds-and-validation) before/during expansion; reject unsafe or duplicate paths, unexpected file types, unsupported versions and malformed JSON.
2. Validate each manifest against `archive-v1.schema.json`, enabling date-time/UUID formats, then apply the semantic checks that JSON Schema cannot express. Validate final completion, shared owner/set identity, contiguous part numbers, one profile, unique record/photo IDs, timestamps, exact photo paths, file checksums, cross-part references, bounded JPEG headers and decoded dimensions. The media record and JPEG must share a part even if the post that uses them is elsewhere. Re-read/recheck staged bytes when used rather than trusting mutable original file handles.
3. Treat source author IDs, handle, relationship roles, creation times and previous provenance as unverified data from the file. A password-authenticated archive is not signed by the original member. Do not resolve arbitrary URLs, fetch unavailable parent content, execute archive HTML, load profile scripts, or grant access from a source identifier. Render text escaped. Never interpret archive fields as instructions.
4. Show counts and planned changes before writes: eligible/expired entries, photos, any included profile, private-journal conversions, unsupported data, and references that will not become relationships. Explain that comments/reactions cannot recreate an inaccessible thread. Allow cancellation. Do not report an all-or-nothing account migration: current imports are incremental and earlier successful batches survive a later failure.

Both current clients retain source archives separately from destination content and prepare bounded parts. Web can stage files using browser-selected handles; native stages files in a protected temporary directory. An adapter must bound its own index/memory use too, and erase temporary decrypted files when no longer needed. Neither file deletion nor archive expiry can revoke a copy the member already shared elsewhere.

## Existing destination behavior

| Source data | Current Porchday destination behavior |
| --- | --- |
| Authored post | New destination UUID; newly encrypted, signed private post; original creation time and deadline retained. |
| Authored comment | Independent private journal post with provenance and unavailable parent ID; not attached to someone else's thread. |
| Own reaction | Independent private journal post such as `Imported reaction: like`; not a new reaction notification or count on the source target. |
| Profile/theme | Re-encrypted for the destination member, audience `only_me`, with a new destination revision. Web offers an explicit replace-profile option. Native currently imports a present profile as part of confirming the import; see its preview UI before use. |
| Photo referenced by an eligible entry/profile | Check bytes, preserve alt text and the earliest original photo/parent expiry, allocate a fresh destination UUID, encrypt locally and upload. Native re-encodes safely; destination bytes/checksum may change. |
| Unreferenced owned photo, including an owned group image | Preserve as a private photo journal entry when still live; do not silently drop it because no destination group is created. |
| Connections and memberships | Keep as source references in the portable file; importer does not create friendships, send invitations, join groups, or transfer roles. New connections still require fresh consent and the 300-connection cap. |
| Other people's private content, moderation evidence, login/recovery material | Not an ordinary export category and never imported. Reject or report unexpected sensitive categories rather than treating them as executable configuration. |

Both clients generate a fresh content-local `reactionSecret`. Existing source provenance is nested under `prior_provenance` instead of discarded. There is a current representation difference: web writes `source_member_id` in new provenance, while native writes `member_id`; both write `kind`, `source_id`, original parent/audience/group fields, and `prior_provenance`. Web additionally retains `original_payload` for converted non-post journal entries after removing its old reaction seed. These are payload fields, not required manifest properties or proof of origin. Preserve unfamiliar provenance fields when converting; accept both member-ID spellings rather than inventing a new v1 requirement.

Keep `created_at` when sealing an imported authored entry. Preserve `expires_at` exactly, except a media item's effective deadline must be the earlier of its own original deadline and its new parent's original deadline. At preview and again before each write, skip deadlines at or before the current time. Remove expired photo references from otherwise eligible text/profile data. Do not replace a past deadline with `null`, restart its duration, attach an old comment to a new public post, or use a broader audience merely because its original audience was `connections` or `group`.

## Client/server boundary

The HTTP paths below are relative to the destination origin, under `/api/v1`. They use the actual app's authenticated member session, CSRF/origin protections, recent reauthentication and permission checks. These endpoints do not confer arbitrary social-write access on integrations. The public integration flow is separately scoped; it does not authorize an autonomous agent to import or publish. A new direct client must implement supported authentication instead of copying another application's session cookies.

The current web/native implementation performs these steps locally:

1. Unlock destination device keys and fetch the current `only_me` audience/device directory with `GET /audiences?audience=only_me`. Encrypt/sign all imports to the destination member's trusted device recipients with the current epoch. Re-fetch and retry preparation if the server rejects a stale directory. Archive encryption is independent of destination content encryption; the original member's device keys are not needed to decrypt a portable archive when its archive secret is available.
2. Prepare each destination photo with a new UUID and parent ID, retaining the earliest deadline. POST `/media` with `{id, envelope, byte_size}` for an encrypted media envelope, then PUT its exact encoded bytes to the returned `upload_url`. The reserve/upload authorization, size, ciphertext digest and expiry checks still apply. No JPEG plaintext is sent to the nonprofit. Include successfully prepared IDs in the import record's `media_ids`.
3. Seal an eligible entry as a new content envelope with `kind: "post"`, `audience: "only_me"`, `parentId: null`, `groupId: null`, the destination author/device IDs, revision 1 and the original `createdAt`/`expiresAt`. Comments and reactions are converted to journal payloads before sealing. Keep source context only in encrypted provenance.
4. Send POST `/imports` with the following body, in batches of at most 50 posts. `envelope` below means the real `porchday-openpgp-v1` signed/encrypted object defined by the crypto package, never a plaintext archive entry.

```ts
interface ImportBatchRequest {
  id: string; // Destination import job UUID; reused across this import's batches.
  profile?: { envelope: EncryptedEnvelope };
  posts: Array<{
    envelope: EncryptedEnvelope;
    source_id: string; // `${sourceMemberId}:${kind}:${sourceId}`, max 200 characters.
    media_ids?: string[]; // At most 10 already uploaded destination photo UUIDs.
  }>;
}
// Response: { id: string, imported: string[] }, HTTP 201.
```

The server enforces private post audience and no thread/group attachment, validates signed routing/recipients, attaches authorized photos and deduplicates posts by `(destination author_id, import_source)`. `kind` in `source_id` is `post`, `comment`, `reaction`, or `photo`. The source member and source IDs remain stable across retries, rather than using each new destination UUID. The returned `imported` array contains only newly inserted post IDs; an empty array can mean an idempotent duplicate. Do not use the job ID alone as the deduplication key.

Profile updates and media upload preparation are separate effects: repeating an import may replace the profile again or prepare unused uploaded photos even if a post is deduplicated. Do not claim whole-archive exactly-once or atomic rollback. Track batch outcomes locally, preserve source IDs, and make profile replacement explicit. Profile image attachment uses the existing PUT `/media/:id/attachment` contract after its encrypted profile is stored. This interface guide does not add a bulk restore endpoint or bypass normal account restrictions.

## Export validation is a separate protocol

The server export job is an authorized paging/validation handle, not the portable archive itself. POST `/exports` starts it. Page the returned sections (`profile`, `posts`, `comments`, `post_reactions`, `comment_reactions`, `media`, `connections`, `groups`) through GET `/exports/:id?section=...&cursor=...` until `next_cursor` is null. Fetch owned encrypted photo bytes through the job's media endpoint, verify/decrypt on the client, and combine the two reaction sections into the manifest's `reactions` array.

Retain each server `export_id`, revision and effective deadline for revalidation. After ZIP preparation and optional encryption, immediately before saving that part, POST `/exports/:id/validate` with `{items:[{kind,id,revision,expires_at}]}`, up to 1,000 items per request. These reference IDs can differ from content UUIDs and are not portable-manifest fields. An empty final completion part still validates its job. Cancel the save on any changed/deleted/expired source or invalidated job; DELETE `/exports/:id` when finished/cancelled. Do not present already saved earlier parts as a complete export if the completion part failed.

## Testing an adapter

Start with the checked-in standalone and multipart [synthetic examples](sample/README.md), including the intentionally expired comment and unavailable parent reference. Demonstrate complete-set validation, wrong-secret/tampered-file rejection, checksum failure, path/expansion rejection, deadline preservation, no automatic relationship writes, private audience enforcement and stable source-ID deduplication. Test a second import of the same source, cancellation between batches, and directory/expiry changes during preparation against a disposable destination.

The repository's archive contract tests validate schema, real web packing/reading, synthetic photos, multipart handling, deadlines and crypto wrapping. Existing API/private-import and native crypto tests supply additional implementation evidence. There is no checked-in assertion that every external social platform can accept these fields, no public adapter registry, and no completed legal/security review implied by an archive schema.
