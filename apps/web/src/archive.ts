import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { Json } from "./api";
import {
  customPngBytes,
  validateCustomPng,
  unicodeMetadata,
  LEGACY_REACTIONS,
} from "@porchday/crypto/reactions";
import type { EmojiLibrary } from "./emoji-library";
export const PART_BUDGET = 20 * 1024 * 1024;
export const PART_MAX = 30 * 1024 * 1024;
export interface ArchiveSet {
  id: string;
  index: number;
  total: number | null;
  complete?: boolean;
}
export interface PortableArchive extends Json {
  format: "porchday-archive";
  version: 1;
  generated_at: string;
  member_id: string;
  handle: string;
  archive_set?: ArchiveSet;
  profile: Json | null;
  emojiLibrary?: EmojiLibrary | null;
  posts: Json[];
  comments: Json[];
  reactions: Json[];
  media: Json[];
  connections: Json[];
  groups: Json[];
}
export function emptyArchive(
  memberId: string,
  handle: string,
  set?: ArchiveSet,
): PortableArchive {
  return {
    format: "porchday-archive",
    version: 1,
    generated_at: new Date().toISOString(),
    member_id: memberId,
    handle,
    ...(set ? { archive_set: set } : {}),
    profile: null,
    posts: [],
    comments: [],
    reactions: [],
    media: [],
    connections: [],
    groups: [],
  };
}
export const htmlEscape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function checksum(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/** Render only local static PNG bytes or escaped text, never an authored URL. */
export function archiveReactionHtml(payload: Json) {
  if (typeof payload.emoji !== "string") return "";
  if (/^c1_[a-f0-9]{64}$/.test(payload.emoji) && payload.custom) {
    try {
      if (!/^[a-z0-9_]{1,32}$/.test(payload.custom.name))
        throw new Error("Invalid name");
      const bytes = customPngBytes(payload.custom.png);
      validateCustomPng(bytes);
      return `<span><img width="32" height="32" src="data:image/png;base64,${payload.custom.png}" alt="${htmlEscape(payload.custom.name)}"> ${htmlEscape(payload.custom.name)}</span>`;
    } catch {
      return htmlEscape("Unavailable image reaction");
    }
  }
  const legacy = LEGACY_REACTIONS.find((item) => item.id === payload.emoji);
  const unicode =
    typeof payload.unicode === "string"
      ? unicodeMetadata(payload.unicode)
      : null;
  return htmlEscape(legacy?.unicode ?? unicode?.unicode ?? payload.emoji);
}
export function packArchive(
  archive: PortableArchive,
  photos: Record<string, Uint8Array> = {},
) {
  const files: Record<string, Uint8Array> = {
    ...photos,
    "archive.json": strToU8(JSON.stringify(archive, null, 2)),
    "index.html": strToU8(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your Porchday archive</title><style>body{font:18px/1.6 system-ui;max-width:760px;margin:60px auto;padding:20px;color:#244e43;background:#f6f3ea}article{padding:25px 0;border-bottom:1px solid #bbb}img{max-width:100%}small{font-size:14px}p{white-space:pre-wrap}</style><h1>Your Porchday archive</h1><p>@${htmlEscape(archive.handle)} · ${htmlEscape(archive.generated_at)}</p><p>${archive.archive_set ? `Part ${archive.archive_set.index}${archive.archive_set.total ? " of " + archive.archive_set.total : ""}. Keep all files in this archive set. Extract all parts into one folder to view photos referenced by other parts.` : ""}</p><p>Your contributions only. Other members’ private content is not included. Saved copies are outside the service’s deletion control.</p>${[...archive.posts, ...archive.comments, ...archive.reactions].map((p) => `<article><small>${htmlEscape(p.created_at)} · ${htmlEscape(p.audience)}${p.expires_at ? " · Original expiry " + htmlEscape(p.expires_at) : ""}</small><p>${htmlEscape(p.payload.text || "")}${p.payload.emoji ? archiveReactionHtml(p.payload) : ""}</p>${(p.payload.media || []).map((m: Json) => `<figure><img src="photos/${htmlEscape(m.id)}.jpg" alt="${htmlEscape(m.alt)}"><figcaption>${htmlEscape(m.alt)}</figcaption></figure>`).join("")}</article>`).join("")}${archive.emojiLibrary ? `<section><h2>My images</h2>${archive.emojiLibrary.customEmojis.map((item) => `<p>${archiveReactionHtml(item)}</p>`).join("")}</section>` : ""}<p>See archive.json for profile, saved emoji images, connection/group references, reactions, and provenance. Reference IDs do not reveal unavailable private context.</p></html>`,
    ),
  };
  if (archive.archive_set) {
    const part = String(archive.archive_set.index).padStart(3, "0");
    files[`index-part-${part}.html`] = files["index.html"];
    delete files["index.html"];
    files[`archive-part-${part}.json`] = files["archive.json"];
    if (archive.archive_set.complete)
      files["index.html"] = strToU8(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Your Porchday archive</title><h1>Your Porchday archive</h1><p>Extract all parts into one directory. Your photos are in the photos folder.</p><ul>${Array.from({ length: archive.archive_set.total || 0 }, (_, i) => `<li><a href="index-part-${String(i + 1).padStart(3, "0")}.html">Part ${i + 1}</a></li>`).join("")}</ul></html>`,
      );
  }
  const zip = zipSync(files, { level: 5 });
  if (zip.length > PART_MAX)
    throw new Error("This archive part exceeds the size limit.");
  return zip;
}
export function unpackArchive(bytes: Uint8Array): {
  archive: PortableArchive;
  files: Record<string, Uint8Array>;
} {
  if (bytes.length > PART_MAX)
    throw new Error("Each archive part must be 30 MB or smaller.");
  let total = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      count++;
      if (
        total > 35 * 1024 * 1024 ||
        entry.originalSize > PART_MAX ||
        count > 5000 ||
        entry.name.startsWith("/") ||
        entry.name.includes("\\") ||
        entry.name.split("/").some((p) => p === ".." || p === "")
      )
        throw new Error(
          "This archive has unsafe paths or exceeds safe expansion limits.",
        );
      return true;
    },
  });
  if (!files["archive.json"] || files["archive.json"].length > 8 * 1024 * 1024)
    throw new Error("This is not a supported Porchday archive.");
  let archive: PortableArchive;
  try {
    archive = JSON.parse(strFromU8(files["archive.json"]));
  } catch {
    throw new Error("The archive index is not valid JSON.");
  }
  if (
    archive.format !== "porchday-archive" ||
    archive.version !== 1 ||
    typeof archive.member_id !== "string" ||
    !Array.isArray(archive.posts) ||
    !Array.isArray(archive.comments) ||
    !Array.isArray(archive.reactions) ||
    !Array.isArray(archive.media) ||
    !Array.isArray(archive.connections) ||
    !Array.isArray(archive.groups)
  )
    throw new Error("This archive uses an unsupported schema.");
  for (const entry of [
    ...archive.posts,
    ...archive.comments,
    ...archive.reactions,
  ]) {
    if (
      typeof entry.id !== "string" ||
      !entry.payload ||
      typeof entry.payload !== "object" ||
      !Number.isFinite(Date.parse(entry.created_at)) ||
      (entry.expires_at !== null &&
        entry.expires_at !== undefined &&
        !Number.isFinite(Date.parse(entry.expires_at)))
    )
      throw new Error("An authored entry is malformed.");
    if (
      entry.payload.text !== undefined &&
      (typeof entry.payload.text !== "string" ||
        entry.payload.text.length > 5000)
    )
      throw new Error("An authored entry exceeds supported text limits.");
    if (
      entry.payload.media !== undefined &&
      (!Array.isArray(entry.payload.media) || entry.payload.media.length > 10)
    )
      throw new Error("An authored entry has invalid photo references.");
  }
  for (const media of archive.media) {
    if (
      typeof media.id !== "string" ||
      !/^photos\/[A-Za-z0-9_-]+\.jpg$/.test(media.path) ||
      media.mime !== "image/jpeg" ||
      !files[media.path] ||
      typeof media.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(media.sha256) ||
      (media.expires_at != null &&
        (typeof media.expires_at !== "string" ||
          !Number.isFinite(Date.parse(media.expires_at))))
    )
      throw new Error("A photo reference is missing or malformed.");
  }
  if (archive.archive_set) {
    const s = archive.archive_set;
    if (
      typeof s.id !== "string" ||
      !Number.isSafeInteger(s.index) ||
      s.index < 1 ||
      (s.total !== null &&
        (!Number.isSafeInteger(s.total) || s.total < s.index))
    )
      throw new Error("The multipart archive index is invalid.");
  }
  return { archive, files };
}
export function validateSet(parts: PortableArchive[]) {
  if (!parts.length) throw new Error("Choose an archive.");
  const first = parts[0];
  if (parts.some((p) => p.member_id !== first.member_id))
    throw new Error("These parts belong to different source accounts.");
  if (!first.archive_set) {
    if (parts.length !== 1 || parts.some((p) => p.archive_set))
      throw new Error(
        "Select only one standalone archive, or all parts of one multipart set.",
      );
    return;
  }
  if (parts.some((p) => p.archive_set?.id !== first.archive_set!.id))
    throw new Error("These files are from different archive sets.");
  const complete = parts.filter((p) => p.archive_set?.complete);
  if (complete.length !== 1)
    throw new Error("Include the final completion part of this archive.");
  const total = complete[0].archive_set!.total;
  if (total !== parts.length)
    throw new Error(
      `This archive has ${total} parts. Choose all of them together.`,
    );
  const indexes = new Set(parts.map((p) => p.archive_set!.index));
  if (
    indexes.size !== parts.length ||
    !Array.from({ length: parts.length }, (_, i) => i + 1).every((i) =>
      indexes.has(i),
    )
  )
    throw new Error("An archive part is missing or duplicated.");
}
export function eligibleEntries(
  parts: PortableArchive[],
  now = Date.now(),
): Json[] {
  const entries: Json[] = parts.flatMap((part) => [
    ...part.posts.map((p: Json): Json => ({ ...p, journal_kind: "post" })),
    ...part.comments.map(
      (p: Json): Json => ({ ...p, journal_kind: "comment" }),
    ),
    ...part.reactions.map(
      (p: Json): Json => ({ ...p, journal_kind: "reaction" }),
    ),
  ]);
  return entries.filter((e) => !e.expires_at || Date.parse(e.expires_at) > now);
}

/** A migrated attachment keeps whichever original deadline is earliest. */
export function preservedPhotoDeadline(
  photoDeadline: string | null | undefined,
  parentDeadline: string | null,
  now = Date.now(),
): string | null {
  const deadlines = [photoDeadline, parentDeadline].filter(
    (value): value is string => value != null,
  );
  if (deadlines.some((value) => !Number.isFinite(Date.parse(value))))
    throw new Error("A photo has an invalid expiration date.");
  const earliest = deadlines.length
    ? Math.min(...deadlines.map(Date.parse))
    : null;
  if (earliest !== null && earliest <= now)
    throw new Error(
      "A photo expired. Review the available photos before trying again.",
    );
  return earliest === null ? null : new Date(earliest).toISOString();
}

/** Expensive preparation must finish before the final server authorization check. */
export async function prepareValidatedExport<T>(
  prepare: () => Promise<T>,
  validate: () => Promise<void>,
  ensureContinue: () => void,
): Promise<T> {
  ensureContinue();
  const prepared = await prepare();
  ensureContinue();
  await validate();
  ensureContinue();
  return prepared;
}
