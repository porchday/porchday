import type { ContentContext, EncryptedEnvelope } from "@porchday/crypto";
import { canonicalJson } from "@porchday/crypto";
import { ApiError, type Content, type MediaPayload, type SocialObject } from "./api";
import { preservedPhotoDeadline } from "./archive";

export type RefreshPost = SocialObject & {
  media: { id: string; byte_size: number; envelope: EncryptedEnvelope }[];
};
export type AudienceRefreshBody = {
  envelope: EncryptedEnvelope;
  lifecycle: unknown;
  source_revision: number;
  source_expires_at: string | null;
  source_media_ids: string[];
  media_ids: string[];
};
export type PreparedAudienceRefresh = {
  id: string;
  source: EncryptedEnvelope;
  body: AudienceRefreshBody;
};
type PreparationIO = {
  memberId: string;
  deviceId: string;
  readPost: (id: string, signal: AbortSignal) => Promise<RefreshPost>;
  open: (row: { envelope: EncryptedEnvelope; id: string; author_id?: string }) => Promise<Content>;
  // This must use the server's per-post history-consent snapshot, NOT the
  // ordinary current-friends audience. One snapshot seals the entire batch.
  prepareAudience: (post: RefreshPost, signal: AbortSignal) => Promise<
    (payload: Content, context: ContentContext) => Promise<EncryptedEnvelope>
  >;
  readMedia: (id: string, signal: AbortSignal) => Promise<EncryptedEnvelope>;
  validatePhoto: (content: Content) => Promise<void>;
  upload: (id: string, envelope: EncryptedEnvelope, sourceRevision: number) => Promise<void>;
  cleanup: (ids: string[]) => Promise<void>;
  sign: (statement: unknown) => Promise<unknown>;
  current: () => boolean;
  now?: () => number;
  newId?: () => string;
};

function canceled() { return new DOMException("Sharing stopped.", "AbortError"); }
function sameIds(a: string[], b: string[]) {
  const sorted = [...b].sort();
  return a.length === b.length && [...a].sort().every((id, index) => id === sorted[index]);
}

/** Re-encrypt only this author's contribution. The original post identity,
 * creation date, reaction secret and absolute deadline remain unchanged.
 * Other members' comments/reactions are never copied or redistributed here.
 */
export async function preparePostAudienceRefresh(
  id: string, io: PreparationIO, signal: AbortSignal,
): Promise<PreparedAudienceRefresh> {
  const now = io.now || Date.now, newId = io.newId || (() => crypto.randomUUID());
  const check = () => { if (!io.current() || signal.aborted) throw canceled(); };
  const uploaded: string[] = [];
  check();
  const row = await io.readPost(id, signal); check();
  const source = row.envelope, context = source.context;
  if (row.id !== id || row.author_id !== io.memberId || context.id !== id ||
      context.authorId !== io.memberId || context.kind !== "post" || context.parentId !== null ||
      context.groupId !== null || row.group_id ||
      !["connections", "friends", "family"].includes(context.audience) ||
      row.audience !== context.audience)
    throw Error("This post cannot be shared through connection history.");
  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
  if (context.expiresAt !== expiresAt || (expiresAt && Date.parse(expiresAt) <= now()))
    throw Error("This post's deadline changed or expired.");
  if (!Array.isArray(row.media) || row.media.length > 10 ||
      new Set(row.media.map(item => item.id)).size !== row.media.length)
    throw Error("This post's photo list is unavailable.");
  const content = await io.open(row); check();
  const originalMedia = content.media || [];
  if (!Array.isArray(originalMedia) || originalMedia.length > 10 ||
      new Set(originalMedia.map(item => item.id)).size !== originalMedia.length ||
      row.media.some(item => !originalMedia.some(photo => photo.id === item.id)))
    throw Error("This post's photo references changed.");
  const seal = await io.prepareAudience(row, signal); check();
  const media: MediaPayload[] = [];
  const sourceMediaIds: string[] = [];
  try {
    // Expired/deleted attachments are absent from the authorized live inventory.
    // Drop their old payload references; never recreate them from saved content.
    for (const photo of originalMedia.filter(item => row.media.some(m => m.id === item.id))) {
      check();
      const original = await io.readMedia(photo.id, signal); check();
      if (original.context.id !== photo.id || original.context.authorId !== io.memberId ||
          original.context.kind !== "media" || original.context.parentId !== id ||
          original.context.audience !== context.audience || original.context.groupId !== null)
        throw Error("A photo does not belong to this post.");
      const payload = await io.open({ envelope: original, id: photo.id, author_id: io.memberId }); check();
      await io.validatePhoto(payload); check();
      const replacement = { ...photo, id: newId() };
      const envelope = await seal({ ...payload, ...replacement }, {
        ...original.context, id: replacement.id, authorDeviceId: io.deviceId,
        createdAt: new Date(now()).toISOString(), revision: 1,
        expiresAt: preservedPhotoDeadline(original.context.expiresAt, expiresAt, now()),
      }); check();
      // Register before reservation/upload: a lost response may have created the
      // unattached object. No post write has happened during preparation.
      uploaded.push(replacement.id);
      await io.upload(replacement.id, envelope, context.revision); check();
      sourceMediaIds.push(photo.id);
      media.push(replacement);
    }
    const envelope = await seal({ ...content, media }, {
      ...context, authorDeviceId: io.deviceId, revision: context.revision + 1,
      expiresAt,
    }); check();
    const lifecycle = await io.sign({
      purpose: "porchday-lifecycle", id, revision: envelope.context.revision, expiresAt,
    }); check();
    return { id, source, body: {
      envelope, lifecycle, source_revision: context.revision, source_expires_at: expiresAt,
      source_media_ids: sourceMediaIds, media_ids: media.map(item => item.id),
    } };
  } catch (error) {
    // Nothing has attempted to attach these unique media IDs yet. Do not run
    // cleanup with a different account after logout/navigation cancellation.
    if (io.current() && uploaded.length) await io.cleanup(uploaded).catch(() => {});
    throw error;
  }
}

export type AudienceRefreshState = "idle" | "sharing" | "unconfirmed";
type RefreshIO = {
  list: (signal: AbortSignal) => Promise<{ items: { id: string }[] }>;
  prepare: (id: string, signal: AbortSignal) => Promise<PreparedAudienceRefresh>;
  save: (prepared: PreparedAudienceRefresh) => Promise<void>;
  read: (id: string, signal: AbortSignal) => Promise<RefreshPost>;
  cleanup: (ids: string[]) => Promise<void>;
  state: (state: AudienceRefreshState) => void;
  changed: () => void;
  enabled: () => boolean;
};

/** One bounded batch at a time. Submitted writes are never aborted or blindly
 * retried by focus/reconnect. An uncertain write is reconciled by reading first;
 * only an explicit retry may resubmit its identical bytes.
 */
export function startPostAudienceRefresh(io: RefreshIO) {
  let disposed = false, operation: Promise<void> | null = null;
  let pending: PreparedAudienceRefresh | null = null, paused = false;
  const controllers = new Set<AbortController>();
  const current = () => !disposed && io.enabled();
  const publish = (state: AudienceRefreshState) => { if (!disposed) io.state(state); };
  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, ms = 30000): Promise<T> {
    const controller = new AbortController(); controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(canceled());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => controller.abort(), ms);
        Promise.resolve().then(() => {
          if (!current() || controller.signal.aborted) throw canceled();
          return action(controller.signal);
        }).then(value => {
          if (!current() || controller.signal.aborted) throw canceled();
          resolve(value);
        }, reject).catch(reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function reconcile(): Promise<"committed" | "unchanged" | "changed"> {
    if (!pending) return "changed";
    const latest = await bounded(signal => io.read(pending!.id, signal));
    if (canonicalJson(latest.envelope) === canonicalJson(pending.body.envelope) &&
        sameIds(latest.media.map(m => m.id), pending.body.media_ids)) {
      pending = null; paused = false; if (!disposed) io.changed(); return "committed";
    }
    if (canonicalJson(latest.envelope) === canonicalJson(pending.source) &&
        sameIds(latest.media.map(m => m.id), pending.body.source_media_ids)) return "unchanged";
    // Another edit/refresh won. Avoid deleting replacements that might have
    // been committed and carried into that later edit; server cleanup owns them.
    pending = null; paused = false; return "changed";
  }
  async function submit() {
    if (!pending || !current()) throw canceled();
    const candidate = pending;
    try {
      await io.save(candidate);
      pending = null; paused = false;
      if (!disposed) io.changed();
    } catch (error) {
      paused = true;
      // Even a failed response is followed by a read before deciding anything.
      // Known rejection can discard candidate bytes only after an unchanged read.
      const outcome = await reconcile().catch(() => "unconfirmed" as const);
      if (outcome === "committed") return;
      if (outcome === "unchanged" && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        pending = null;
        if (current()) await io.cleanup(candidate.body.media_ids).catch(() => {});
      }
      throw error;
    }
  }
  function run(manual = false) {
    if (!current()) return Promise.resolve();
    if (operation) return operation;
    const running = (async () => {
      try {
        if (pending) {
          const outcome = await reconcile();
          if (outcome === "unchanged") {
            if (!manual) { publish("unconfirmed"); return; }
            publish("sharing"); await submit();
          }
        }
        if (paused && !manual) { publish("unconfirmed"); return; }
        paused = false;
        const batch = await bounded(io.list);
        if (!batch.items.length) { publish("idle"); return; }
        publish("sharing");
        for (const candidate of batch.items.slice(0, 3)) {
          if (!current()) throw canceled();
          // Preparation includes sequential photo encryption/uploads. Those
          // writes finish normally; the signal only stops reads and later work.
          pending = await bounded(signal => io.prepare(candidate.id, signal), 10 * 60_000);
          await submit();
        }
        publish("idle");
      } catch (error) {
        if (!disposed) {
          // Hiding the app stops unfinished preparation. It can resume when
          // visible again; uncertainty after a submitted write stays explicit.
          const stoppedBeforeWrite = !pending && error instanceof DOMException && error.name === "AbortError";
          paused = !stoppedBeforeWrite;
          publish(stoppedBeforeWrite ? "idle" : "unconfirmed");
        }
      }
    })();
    operation = running;
    void running.finally(() => { if (operation === running) operation = null; });
    return running;
  }
  void run();
  return {
    recheck: () => run(),
    retry: () => run(true),
    suspend() { for (const controller of controllers) controller.abort(); },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); },
  };
}
