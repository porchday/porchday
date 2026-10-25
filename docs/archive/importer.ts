/**
 * Documentation interfaces for archive adapters, not a separately published SDK.
 * The live implementations remain apps/web/src/{archive,DataTransfer}.tsx/ts and
 * apps/ios/Porchday/PortableArchive.swift. See importer-guide.md for required checks.
 */
import type { Audience, EncryptedEnvelope, Json } from "@porchday/crypto";

export type JsonObject = { [key: string]: Json };
export type Timestamp = string; // Canonical UTC ISO: YYYY-MM-DDTHH:mm:ss.sssZ.
export type UUID = string; // Validate before use. Type aliases are not validators.
export type Deadline = Timestamp | null;
export type EntryKind = "post" | "comment" | "reaction" | "photo";

export interface ArchiveSetV1 {
  id: string;
  index: number;
  total: number | null;
  complete?: boolean;
}
export interface AuthoredEntryV1 {
  id: UUID;
  created_at: Timestamp;
  expires_at: Deadline;
  audience: Audience;
  parent_id: UUID | null;
  group_id: UUID | null;
  payload: JsonObject;
}
export interface PhotoV1 {
  id: UUID;
  path: string;
  mime: "image/jpeg";
  alt: string;
  name?: string;
  width: number;
  height: number;
  sha256: string;
  post_id: UUID | null;
  profile_id: UUID | null;
  group_id: UUID | null;
  slot: "avatar" | "cover" | "background" | "image" | null;
  created_at: Timestamp;
  expires_at: Deadline;
}
export interface ArchiveManifestV1 {
  format: "porchday-archive";
  version: 1;
  generated_at: Timestamp;
  member_id: UUID;
  handle: string;
  archive_set?: ArchiveSetV1;
  profile: JsonObject | null;
  posts: AuthoredEntryV1[];
  comments: AuthoredEntryV1[];
  reactions: AuthoredEntryV1[];
  media: PhotoV1[];
  connections: { member_id: UUID; kind: "friend" | "family" }[];
  groups: { group_id: UUID; role: "owner" | "moderator" | "member" }[];
}

/** Same signatures as the existing @porchday/crypto functions. Never upload secret. */
export interface ArchiveEncryption {
  encryptArchive(bytes: Uint8Array, secret?: string): Promise<{ ciphertext: Uint8Array; secret: string }>;
  decryptArchive(ciphertext: Uint8Array, secret: string): Promise<Uint8Array>;
}

/**
 * Optional adapter boundary for a local converter. Implementations must validate
 * ZIP limits, the whole set, photos and expiry before returning a preview.
 * Read one bounded part at a time; do not load an entire account into memory.
 */
export interface LocalArchiveReader<PartHandle> {
  readPart(handle: PartHandle, archiveSecret?: string): Promise<{
    manifest: ArchiveManifestV1;
    readPhoto(photo: PhotoV1): Promise<Uint8Array>;
  }>;
}

/** Exact body of the existing, session-authenticated POST /api/v1/imports. */
export interface ImportBatchRequest {
  id: UUID;
  profile?: { envelope: EncryptedEnvelope };
  posts: {
    envelope: EncryptedEnvelope;
    /** `${sourceMemberId}:${kind}:${sourceId}`, <=200 characters. */
    source_id: string;
    media_ids?: UUID[]; // <=10, already uploaded as destination-owned ciphertext.
  }[]; // <=50. Envelopes must be posts with audience only_me and no parent/group.
}
export interface ImportBatchResult {
  id: UUID;
  imported: UUID[]; // Newly inserted posts, excludes idempotent duplicates.
}
export interface PorchdayImportTransport {
  /** Send ciphertext only, using the destination's actual session/CSRF rules. */
  importBatch(body: ImportBatchRequest): Promise<ImportBatchResult>;
}

/** Exact export revalidation body; these references are NOT archive.json fields. */
export interface ExportValidationRequest {
  items: {
    kind: "profile" | "post" | "comment" | "post_reaction" | "comment_reaction" | "media";
    id: string;
    revision: number;
    expires_at: Deadline;
  }[]; // <=1000 per request; also validate an empty completion part's export job.
}
