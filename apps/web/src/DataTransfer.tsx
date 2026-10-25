import React, { useRef, useState } from "react";
import {
  encryptArchive,
  decryptArchive,
  createRecoverySecret,
  createReactionSecret,
  base64ToBytes,
  bytesToBase64,
  type EncryptedEnvelope,
} from "@porchday/crypto";
import {
  get,
  post,
  request,
  del,
  saveFile,
  type Json,
  type MediaPayload,
} from "./api";
import { Alert, Button, Field, Icon, useAction } from "./ui";
import { useVault } from "./vault";
import {
  emptyArchive,
  packArchive,
  unpackArchive,
  validateSet,
  eligibleEntries,
  checksum,
  preservedPhotoDeadline,
  prepareValidatedExport,
  PART_BUDGET,
  PART_MAX,
  type PortableArchive,
} from "./archive";
import { jpegDimensions, validatedPhoto } from "./photo-safety";
const SECTIONS = [
  "profile",
  "posts",
  "comments",
  "post_reactions",
  "comment_reactions",
  "media",
  "connections",
  "groups",
];
const canonicalDate = (value: unknown) =>
  value ? new Date(String(value)).toISOString() : null;
type Reference = {
  kind:
    | "profile"
    | "post"
    | "comment"
    | "post_reaction"
    | "comment_reaction"
    | "media";
  id: string;
  revision: number;
  expires_at: string | null;
};
type PlannedPart = { file: File; archive: PortableArchive };
type ImportPlan = {
  parts: PlannedPart[];
  entries: Json[];
  media: Map<string, { part: number; record: Json }>;
  profile: Json | null;
  expired: number;
  expiredPhotos: number;
};
export function DataTransfer() {
  const vault = useVault();
  const [plain, setPlain] = useState(false);
  const [archiveKey, setArchiveKey] = useState("");
  const [importKey, setImportKey] = useState("");
  const [progress, setProgress] = useState("");
  const [downloads, setDownloads] = useState<{ name: string; size: number }[]>(
    [],
  );
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [replaceProfile, setReplaceProfile] = useState(true);
  const [directory, setDirectory] = useState<any>(null);
  const cancel = useRef(false);
  const action = useAction();
  function ensureContinue() {
    if (cancel.current)
      throw new Error(
        "Transfer canceled. Any files already saved remain yours.",
      );
  }
  async function chooseDirectory() {
    await action.run(async () => {
      if (!("showDirectoryPicker" in window))
        throw new Error(
          "This browser uses ordinary downloads. Allow multiple downloads if your archive needs more than one part.",
        );
      setDirectory(
        await (window as any).showDirectoryPicker({ mode: "readwrite" }),
      );
    });
  }
  async function exportData() {
    cancel.current = false;
    await action.run(async () => {
      setDownloads([]);
      setArchiveKey("");
      setProgress("Opening your own encrypted records…");
      const key = plain ? "" : createRecoverySecret();
      if (key) setArchiveKey(key);
      const job = await post("/exports");
      const setId = crypto.randomUUID();
      let index = 1;
      let archive = emptyArchive(vault.member.id, vault.member.handle, {
        id: setId,
        index,
        total: null,
      });
      let files: Record<string, Uint8Array> = {};
      let refs: Reference[] = [];
      let byteCount = 0;
      const saved: { name: string; size: number }[] = [];
      let nonempty = false;
      async function flush(final = false) {
        ensureContinue();
        if (!nonempty && !final) return;
        archive.archive_set = {
          id: setId,
          index,
          total: final ? index : null,
          ...(final ? { complete: true } : {}),
        };
        setProgress(`Preparing archive part ${index}…`);
        const bytes = await prepareValidatedExport(
          async () => {
            const zip = packArchive(archive, files);
            return plain ? zip : (await encryptArchive(zip, key)).ciphertext;
          },
          async () => {
            if (!refs.length)
              await post(`/exports/${job.id}/validate`, { items: [] });
            for (let i = 0; i < refs.length; i += 1000)
              await post(`/exports/${job.id}/validate`, {
                items: refs.slice(i, i + 1000),
              });
          },
          ensureContinue,
        );
        const name = `porchday-${setId.slice(0, 8)}-part-${String(index).padStart(3, "0")}.zip${plain ? "" : ".pgp"}`;
        if (directory) {
          const handle = await directory.getFileHandle(name, { create: true });
          const writer = await handle.createWritable();
          try {
            await writer.write(bytes);
            await writer.close();
          } catch (e) {
            await writer.abort();
            throw e;
          }
        } else
          saveFile(
            new Blob([bytes as BlobPart], {
              type: plain ? "application/zip" : "application/pgp-encrypted",
            }),
            name,
          );
        saved.push({ name, size: bytes.length });
        setDownloads([...saved]);
        index++;
        archive = emptyArchive(vault.member.id, vault.member.handle, {
          id: setId,
          index,
          total: null,
        });
        files = {};
        refs = [];
        byteCount = 0;
        nonempty = false;
      }
      async function room(size: number) {
        if (size > PART_BUDGET)
          throw new Error(
            "An individual source item is too large for a safe archive part. Contact the operator with this size issue.",
          );
        if (nonempty && byteCount + size > PART_BUDGET) await flush();
        byteCount += size;
        nonempty = true;
      }
      function reference(kind: Reference["kind"], row: Json): Reference {
        return {
          kind,
          id: String(
            row.export_id || row.id || row.member_id || row.envelope.context.id,
          ),
          revision: row.envelope.context.revision,
          expires_at: canonicalDate(
            row.effective_expires_at ||
              row.expires_at ||
              row.envelope.context.expiresAt,
          ),
        };
      }
      try {
        for (const section of SECTIONS) {
          let cursor: string | null = null;
          do {
            ensureContinue();
            const query: URLSearchParams = new URLSearchParams({
              section,
              ...(cursor ? { cursor } : {}),
            });
            const page: Json = await get(`/exports/${job.id}?${query}`);
            const rows =
              section === "profile"
                ? page.profile
                  ? [page.profile]
                  : []
                : page[section] || [];
            for (const row of rows) {
              ensureContinue();
              setProgress(`Preparing your ${section.replaceAll("_", " ")}…`);
              if (section === "profile") {
                if (row.envelope) {
                  const payload = await vault.open({
                    envelope: row.envelope,
                    id: vault.member.id,
                  });
                  await room(JSON.stringify(payload).length * 3 + 1024);
                  archive.profile = payload;
                  refs.push(reference("profile", row));
                }
              } else if (section === "connections" || section === "groups") {
                await room(JSON.stringify(row).length * 3 + 512);
                archive[section].push(row);
              } else if (section === "media") {
                const response = await fetch(
                  `/api/v1/exports/${job.id}/media/${row.id}/bytes`,
                  { credentials: "same-origin", cache: "no-store" },
                );
                if (!response.ok)
                  throw new Error(
                    "A photo changed or expired during export. Start a fresh export.",
                  );
                const envelope = (await response.json()) as EncryptedEnvelope;
                const payload = await vault.open({ envelope, id: row.id });
                if (
                  payload.mime !== "image/jpeg" ||
                  typeof payload.bytes !== "string"
                )
                  throw new Error(
                    "An exported photo has an unsupported format.",
                  );
                const bytes = base64ToBytes(payload.bytes);
                const dimensions = jpegDimensions(bytes);
                await room(bytes.length + 4096);
                const path = `photos/${row.id}.jpg`;
                files[path] = bytes;
                archive.media.push({
                  id: row.id,
                  path,
                  mime: "image/jpeg",
                  alt: String(payload.alt || ""),
                  name: String(payload.name || ""),
                  ...dimensions,
                  sha256: await checksum(bytes),
                  post_id: row.post_id || null,
                  profile_id: row.profile_member_id || row.profile_id || null,
                  group_id: row.group_id || null,
                  slot: row.slot || null,
                  created_at: canonicalDate(
                    row.created_at || envelope.context.createdAt,
                  ),
                  expires_at: canonicalDate(
                    row.effective_expires_at || envelope.context.expiresAt,
                  ),
                });
                refs.push(reference("media", { ...row, envelope }));
              } else {
                const payload = await vault.open({
                  envelope: row.envelope,
                  id: row.id,
                });
                const entry = {
                  id: row.id || row.envelope.context.id,
                  created_at: canonicalDate(
                    row.created_at || row.envelope.context.createdAt,
                  ),
                  expires_at: canonicalDate(
                    row.effective_expires_at ||
                      row.expires_at ||
                      row.envelope.context.expiresAt,
                  ),
                  audience: row.audience || row.envelope.context.audience,
                  parent_id:
                    row.parent_id || row.post_id || row.comment_id || null,
                  group_id: row.group_id || null,
                  payload,
                };
                await room(JSON.stringify(entry).length * 3 + 1024);
                archive[
                  section.endsWith("reactions") ? "reactions" : section
                ].push(entry);
                refs.push(
                  reference(
                    section === "posts"
                      ? "post"
                      : section === "comments"
                        ? "comment"
                        : section === "post_reactions"
                          ? "post_reaction"
                          : "comment_reaction",
                    row,
                  ),
                );
              }
            }
            cursor = page.next_cursor || null;
          } while (cursor);
        }
        await flush(true);
        setProgress(
          `Your archive is complete: ${saved.length} ${saved.length === 1 ? "part" : "parts"}. Keep every part together${plain ? "" : ", with the separate archive secret"}.`,
        );
      } finally {
        await del(`/exports/${job.id}`).catch(() => {});
      }
    }, "Your archive was decrypted and prepared only on this device.");
  }
  async function unpackFile(file: File) {
    if (file.size > PART_MAX + 1024 * 1024)
      throw new Error("Choose archive parts no larger than 31 MB.");
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (file.name.endsWith(".pgp")) {
      if (!importKey.trim())
        throw new Error(
          "Enter the archive secret before selecting encrypted parts.",
        );
      bytes = (await decryptArchive(
        bytes,
        importKey.trim(),
      )) as Uint8Array<ArrayBuffer>;
    }
    return unpackArchive(bytes);
  }
  async function selectFiles(selected: FileList | null) {
    if (!selected?.length) return;
    cancel.current = false;
    await action.run(async () => {
      setPlan(null);
      const parts: PlannedPart[] = [];
      const media = new Map<string, { part: number; record: Json }>();
      let profile: Json | null = null;
      for (const file of Array.from(selected)) {
        ensureContinue();
        setProgress(`Checking ${file.name}…`);
        const { archive, files } = await unpackFile(file);
        for (const photo of archive.media) {
          if (!photo.expires_at || Date.parse(photo.expires_at) > Date.now())
            jpegDimensions(files[photo.path]);
          if ((await checksum(files[photo.path])) !== photo.sha256)
            throw new Error(
              "A photo checksum did not match. The archive may be incomplete or modified.",
            );
          if (media.has(photo.id))
            throw new Error("This archive repeats a photo identifier.");
          media.set(photo.id, { part: parts.length, record: photo });
        }
        if (archive.profile) {
          if (profile) throw new Error("This archive repeats its profile.");
          profile = archive.profile;
        }
        parts.push({ file, archive });
      }
      validateSet(parts.map((p) => p.archive));
      const entries = eligibleEntries(parts.map((p) => p.archive));
      const photoAvailable = (id: string) => {
        const photo = media.get(id)?.record;
        if (!photo)
          throw new Error(
            "A referenced photo is missing. Select every archive part.",
          );
        return !photo.expires_at || Date.parse(photo.expires_at) > Date.now();
      };
      for (const entry of entries)
        entry.payload = {
          ...entry.payload,
          media: (entry.payload.media || []).filter((photo: Json) =>
            photoAvailable(photo.id),
          ),
        };
      if (profile) {
        profile = { ...profile };
        for (const slot of ["avatar", "cover", "background"])
          if (profile[slot] && !photoAvailable(profile[slot].id))
            delete profile[slot];
      }
      const referencedMedia = new Set<string>(
        entries.flatMap((e) => (e.payload.media || []).map((m: Json) => m.id)),
      );
      for (const slot of ["avatar", "cover", "background"])
        if (profile?.[slot]) referencedMedia.add(profile[slot].id);
      for (const { record } of media.values()) {
        if (
          !referencedMedia.has(record.id) &&
          (!record.expires_at || Date.parse(record.expires_at) > Date.now())
        )
          entries.push({
            id: record.id,
            journal_kind: "photo",
            created_at: record.created_at || parts[0].archive.generated_at,
            expires_at: record.expires_at || null,
            audience: "only_me",
            parent_id: record.post_id || record.group_id || null,
            group_id: record.group_id || null,
            payload: {
              text: "Imported photo",
              media: [
                {
                  id: record.id,
                  alt: record.alt || "",
                  name: record.name || "photo.jpg",
                  mime: "image/jpeg",
                  width: record.width,
                  height: record.height,
                },
              ],
            },
          });
      }
      const ids = new Set<string>();
      for (const entry of entries) {
        const sourceKey = `${entry.journal_kind}:${entry.id}`;
        if (ids.has(sourceKey))
          throw new Error("This archive repeats an authored entry.");
        ids.add(sourceKey);
        for (const photo of entry.payload.media || [])
          if (!media.has(photo.id))
            throw new Error(
              "A referenced photo is missing. Select every archive part.",
            );
      }
      for (const key of ["avatar", "cover", "background"])
        if (profile?.[key] && !media.has(profile[key].id))
          throw new Error(
            "A profile photo is missing. Select every archive part.",
          );
      const allCount = parts.reduce(
        (n, p) =>
          n +
          p.archive.posts.length +
          p.archive.comments.length +
          p.archive.reactions.length,
        0,
      );
      setPlan({
        parts,
        entries,
        media,
        profile,
        expired: allCount - eligibleEntries(parts.map((p) => p.archive)).length,
        expiredPhotos: [...media.values()].filter(
          ({ record }) =>
            record.expires_at && Date.parse(record.expires_at) <= Date.now(),
        ).length,
      });
      setProgress(
        "Your archive is checked. Review the import before continuing.",
      );
    });
  }
  async function importData() {
    if (!plan) return;
    cancel.current = false;
    await action.run(async () => {
      const source = plan.parts[0].archive.member_id;
      let cachedPart = -1;
      let cachedFiles: Record<string, Uint8Array> = {};
      const uploads = new Map<string, MediaPayload>();
      async function loadPhoto(oldId: string) {
        const found = plan!.media.get(oldId);
        if (!found) throw new Error("A referenced photo is missing.");
        if (cachedPart !== found.part) {
          const parsed = await unpackFile(plan!.parts[found.part].file);
          cachedPart = found.part;
          cachedFiles = parsed.files;
        }
        const bytes = cachedFiles[found.record.path];
        if (!bytes || (await checksum(bytes)) !== found.record.sha256)
          throw new Error("A photo changed after the import preview.");
        const { width, height } = await validatedPhoto(bytes);
        return { bytes, record: { ...found.record, width, height } as Json };
      }
      async function uploadPhoto(
        old: Json,
        parentId: string,
        createdAt: string,
        expiresAt: string | null,
      ) {
        ensureContinue();
        const { bytes, record } = await loadPhoto(old.id);
        const photoExpiresAt = preservedPhotoDeadline(
          record.expires_at,
          expiresAt,
        );
        const mediaId = crypto.randomUUID();
        const meta: MediaPayload = {
          id: mediaId,
          alt: String(old.alt || record.alt || ""),
          name: String(old.name || record.name || "photo.jpg"),
          mime: "image/jpeg",
          width: record.width,
          height: record.height,
        };
        const envelope = await vault.seal(
          { ...meta, bytes: bytesToBase64(bytes) },
          {
            id: mediaId,
            kind: "media",
            audience: "only_me",
            parentId,
            createdAt,
            expiresAt: photoExpiresAt,
          },
        );
        const packed = new TextEncoder().encode(JSON.stringify(envelope));
        const upload = await post("/media", {
          id: mediaId,
          envelope,
          byte_size: packed.length,
        });
        await request(upload.upload_url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([packed]),
        });
        return meta;
      }
      let importedCount = 0;
      for (
        let batchStart = 0;
        batchStart < plan.entries.length;
        batchStart += 50
      ) {
        const batch = [];
        for (const entry of plan.entries.slice(batchStart, batchStart + 50)) {
          ensureContinue();
          if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now())
            continue;
          setProgress(
            `Importing your memories (${importedCount + batch.length + 1}/${plan.entries.length})…`,
          );
          const id = crypto.randomUUID();
          const media = [];
          for (const photo of entry.payload.media || [])
            media.push(
              await uploadPhoto(
                photo,
                id,
                new Date(entry.created_at).toISOString(),
                canonicalDate(entry.expires_at),
              ),
            );
          const originalPayload = { ...entry.payload };
          delete originalPayload.reactionSecret;
          const payload = {
            ...entry.payload,
            ...(entry.journal_kind === "reaction"
              ? {
                  text: `Imported reaction: ${String(entry.payload.emoji || "reaction")}`,
                }
              : {}),
            media,
            reactionSecret: createReactionSecret(),
            provenance: {
              kind: entry.journal_kind,
              source_id: entry.id,
              source_member_id: source,
              parent_id: entry.parent_id || null,
              original_audience: entry.audience,
              original_group_id: entry.group_id,
              prior_provenance: entry.payload.provenance || null,
              original_payload:
                entry.journal_kind !== "post" ? originalPayload : null,
            },
          };
          const envelope = await vault.seal(payload, {
            id,
            kind: "post",
            audience: "only_me",
            createdAt: new Date(entry.created_at).toISOString(),
            expiresAt: canonicalDate(entry.expires_at),
          });
          batch.push({
            envelope,
            source_id: `${source}:${entry.journal_kind}:${entry.id}`,
            media_ids: media.map((m) => m.id),
          });
        }
        if (batch.length) {
          const result = await post("/imports", {
            id: crypto.randomUUID(),
            posts: batch,
          });
          importedCount += (result.imported || []).length;
        }
      }
      if (replaceProfile && plan.profile) {
        const profile = { ...plan.profile };
        const attachments: { id: string; slot: string }[] = [];
        for (const slot of ["avatar", "cover", "background"])
          if (profile[slot]) {
            const meta = await uploadPhoto(
              profile[slot],
              vault.member.id,
              new Date().toISOString(),
              null,
            );
            profile[slot] = meta;
            attachments.push({ id: meta.id, slot });
          }
        const me = await get("/me");
        const envelope = await vault.seal(profile, {
          id: vault.member.id,
          kind: "profile",
          audience: "only_me",
          createdAt: me.envelope?.context.createdAt || new Date().toISOString(),
          revision: (me.envelope?.context.revision || 0) + 1,
        });
        await post("/imports", {
          id: crypto.randomUUID(),
          posts: [],
          profile: { envelope },
        });
        for (const asset of attachments)
          await request(`/media/${asset.id}/attachment`, {
            method: "PUT",
            body: JSON.stringify({
              kind: "profile",
              target_id: vault.member.id,
              slot: asset.slot,
            }),
          });
      }
      setPlan(null);
      setProgress(
        `Imported ${importedCount} new private entries. Previously imported entries were skipped. No connections or group memberships were created.`,
      );
    }, "Your memories were re-encrypted for this account before upload.");
  }
  return (
    <>
      <section className="panel form-stack">
        <span className="feature-icon sage">
          <Icon name="download" size={28} />
        </span>
        <h2>Your memories. Your choice.</h2>
        <p>
          Export your own posts, comments, reactions, photos, profile, and
          minimal connection/group references. Other people’s private content is
          not included.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={plain}
            onChange={(e) => setPlain(e.target.checked)}
          />
          <span>
            Download readable, unencrypted ZIP files instead of the default
            encrypted archive. Anyone with these files can read them.
          </span>
        </label>
        <div className="button-row">
          <Button
            variant="outline compact"
            onClick={chooseDirectory}
            disabled={action.busy}
          >
            {directory ? "Change download folder" : "Choose a download folder"}
          </Button>
          {directory && <span className="small-copy">{directory.name}</span>}
        </div>
        <p className="small-copy">
          Large archives are split into parts. Keep every part, including the
          final completion part. Without a chosen folder, your browser may ask
          you to allow multiple downloads.
        </p>
        <div className="button-row">
          <Button variant="primary" busy={action.busy} onClick={exportData}>
            <Icon name="download" size={18} />
            Export my data
          </Button>
          {action.busy && (
            <Button
              variant="quiet"
              onClick={() => {
                cancel.current = true;
              }}
            >
              Cancel transfer
            </Button>
          )}
        </div>
        {archiveKey && (
          <div className="form-stack">
            <Alert success>
              Save this archive secret separately. It unlocks every part and is
              different from your account recovery secret.
            </Alert>
            <code className="secret-box">{archiveKey}</code>
            <Button
              variant="outline compact"
              onClick={() =>
                saveFile(
                  new Blob([archiveKey], { type: "text/plain" }),
                  "porchday-archive-secret.txt",
                )
              }
            >
              Save archive secret
            </Button>
          </div>
        )}
        {downloads.length > 0 && (
          <details>
            <summary>{downloads.length} archive files prepared</summary>
            <ul className="download-list">
              {downloads.map((d) => (
                <li key={d.name}>
                  {d.name} <small>{(d.size / 1048576).toFixed(1)} MB</small>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="small-copy">
          Readable exports are created only on your device. A downloaded copy is
          outside the service’s deletion control, even when its original content
          expires.
        </p>
      </section>
      {!["restricted", "suspended"].includes(vault.member.status || "") && (
        <section className="panel form-stack">
          <h2>Bring your memories with you</h2>
          <p>
            Import an archive from Porchday. Choose all parts together. Photos
            and checksums are checked before your preview; content is
            re-encrypted here for your account.
          </p>
          <Field
            label="Archive secret, for encrypted parts"
            type="password"
            autoComplete="off"
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
          />
          <label className="file-button button outline">
            <Icon name="plus" size={17} />
            Choose archive files
            <input
              type="file"
              accept=".zip,.pgp"
              multiple
              onChange={(e) => selectFiles(e.target.files)}
            />
          </label>
          {plan && (
            <div className="import-preview">
              <h3>Review your import</h3>
              <p>
                {plan.entries.length} unexpired authored entries ·{" "}
                {plan.media.size - plan.expiredPhotos} unexpired photos ·{" "}
                {plan.parts.length} archive parts · {plan.expired} expired
                entries and {plan.expiredPhotos} expired photos skipped.
              </p>
              <p>
                Posts begin as “Only me.” Your comments and reactions become
                private journal entries with their original text or choice,
                timestamps, expiry, and context references. Other people’s
                threads are not recreated. Unattached or group-owned photos are
                preserved as private photo journal entries.
              </p>
              {plan.profile && (
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={replaceProfile}
                    onChange={(e) => setReplaceProfile(e.target.checked)}
                  />
                  <span>
                    Replace my profile with the archived profile, initially
                    private to this account.
                  </span>
                </label>
              )}
              <p>
                No invitations are sent. Connections and memberships remain
                reference data; reconnecting always requires fresh mutual
                agreement.
              </p>
              <Button variant="primary" busy={action.busy} onClick={importData}>
                Import my memories privately
              </Button>
            </div>
          )}
          <p className="small-copy">
            JSON, HTML, JPEG photos, and checksums are portable files. Other
            platforms decide which fields they can accept; no direct destination
            adapter is promised.
          </p>
        </section>
      )}
      {progress && (
        <p className="transfer-progress" role="status">
          {progress}
        </p>
      )}
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
    </>
  );
}
