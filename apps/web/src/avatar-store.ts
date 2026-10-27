/** Decrypted avatars live only while an unlocked screen is using them. */
export type AvatarPhoto = { photoId: string; expiresAt: number | null; blob?: Blob };
type Entry = {
  listeners: Set<() => void>;
  url: string;
  photo?: AvatarPhoto;
  checked: number;
  request?: AbortController;
  queued: boolean;
  expiry?: ReturnType<typeof setTimeout>;
};
export function createAvatarStore(
  load: (memberId: string, signal: AbortSignal, previous?: AvatarPhoto) => Promise<AvatarPhoto | null>,
  urls = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) },
) {
  const entries = new Map<string, Entry>();
  let running = 0;
  function changed(entry: Entry) { for (const notify of entry.listeners) notify(); }
  function clearPhoto(entry: Entry) {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = undefined;
    if (entry.url) urls.revoke(entry.url);
    entry.url = ""; entry.photo = undefined;
  }
  function pump() {
    for (const [id, entry] of entries) {
      if (running >= 4) break;
      if (!entry.queued || entry.request) continue;
      entry.queued = false;
      const controller = new AbortController();
      entry.request = controller; running++;
      const current = () => entries.get(id) === entry && entry.request === controller && !controller.signal.aborted;
      void load(id, controller.signal, entry.photo).then(photo => {
        if (!current()) return;
        if (!photo || (photo.expiresAt !== null && photo.expiresAt <= Date.now())) {
          clearPhoto(entry);
        } else {
          if (photo.blob) {
            clearPhoto(entry);
            entry.url = urls.create(photo.blob);
          } else if (!entry.url || entry.photo?.photoId !== photo.photoId) {
            throw Error("Photo data is unavailable.");
          }
          // Do not retain the decoded bytes as well as the object URL.
          entry.photo = { photoId: photo.photoId, expiresAt: photo.expiresAt };
          if (entry.expiry) clearTimeout(entry.expiry);
          const expire = () => {
            if (entries.get(id) !== entry || !entry.photo || entry.photo.expiresAt === null) return;
            const remaining = entry.photo.expiresAt - Date.now();
            if (remaining <= 0) { clearPhoto(entry); changed(entry); }
            else entry.expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          };
          expire();
        }
        entry.checked = Date.now(); changed(entry);
      }).catch(() => {
        if (current()) { clearPhoto(entry); entry.checked = Date.now(); changed(entry); }
      }).finally(() => {
        running--;
        if (entry.request === controller) entry.request = undefined;
        pump();
      });
    }
  }
  return {
    getURL(id: string) { return entries.get(id)?.url || ""; },
    subscribe(id: string, notify: () => void) {
      let entry = entries.get(id);
      if (!entry) {
        entry = { listeners: new Set(), url: "", checked: 0, queued: true };
        entries.set(id, entry);
      }
      entry.listeners.add(notify); pump();
      return () => {
        entry.listeners.delete(notify);
        if (!entry.listeners.size) {
          entry.request?.abort(); clearPhoto(entry);
          if (entries.get(id) === entry) entries.delete(id);
        }
      };
    },
    refresh(id?: string, force = false) {
      for (const [memberId, entry] of entries) {
        if (id && memberId !== id) continue;
        if (force) {
          entry.request?.abort(); entry.request = undefined;
          clearPhoto(entry); changed(entry);
        }
        if (force || (!entry.request && Date.now() - entry.checked >= 60_000)) entry.queued = true;
      }
      pump();
    },
    clear() {
      const old = [...entries.values()]; entries.clear();
      for (const entry of old) { entry.request?.abort(); clearPhoto(entry); changed(entry); }
    },
  };
}
