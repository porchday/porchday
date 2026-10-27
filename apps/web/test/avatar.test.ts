import { afterEach, describe, expect, it, vi } from "vitest";
import { createAvatarStore } from "../src/avatar-store";
import { readAvatarPhoto } from "../src/avatar-photo";
import type { EncryptedEnvelope } from "../src/api";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const photo = (photoId = "photo", expiresAt: number | null = null) => ({ photoId, expiresAt, blob: new Blob(["synthetic"]) });
function urls() { let n = 0; return { create: vi.fn(() => `blob:test-${++n}`), revoke: vi.fn() }; }
afterEach(() => vi.useRealTimers());
describe("memory-only shared avatars", () => {
  it("deduplicates repeated authors and revokes only when their last appearance leaves", async () => {
    const load = vi.fn(async () => photo()), io = urls(), store = createAvatarStore(load, io);
    const a = store.subscribe("a", vi.fn()), b = store.subscribe("a", vi.fn());
    await tick(); expect(load).toHaveBeenCalledTimes(1); expect(store.getURL("a")).toBe("blob:test-1");
    a(); expect(io.revoke).not.toHaveBeenCalled();
    b(); expect(io.revoke).toHaveBeenCalledWith("blob:test-1"); expect(store.getURL("a")).toBe("");
  });
  it("replaces and removes every visible copy when a profile changes", async () => {
    const load = vi.fn().mockResolvedValueOnce(photo("old")).mockResolvedValueOnce(photo("new")).mockResolvedValueOnce(null);
    const io = urls(), store = createAvatarStore(load, io), notify = vi.fn();
    store.subscribe("a", notify); await tick();
    store.refresh("a", true); expect(store.getURL("a")).toBe(""); await tick();
    expect(store.getURL("a")).toBe("blob:test-2");
    store.refresh("a", true); await tick(); expect(store.getURL("a")).toBe("");
    expect(io.revoke.mock.calls).toEqual([["blob:test-1"], ["blob:test-2"]]); store.clear();
  });
  it("discards a late decrypted image after invalidation or sign-out", async () => {
    let finish!: (value: ReturnType<typeof photo>) => void;
    const io = urls(), load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
    const store = createAvatarStore(load, io); store.subscribe("a", vi.fn());
    store.refresh(undefined, true); await tick(); finish(photo()); await tick();
    expect(store.getURL("a")).toBe(""); expect(io.create).not.toHaveBeenCalled();
    const other = createAvatarStore(() => new Promise(resolve => { finish = resolve; }), io);
    other.subscribe("a", vi.fn()); other.clear(); finish(photo()); await tick();
    expect(io.create).not.toHaveBeenCalled(); store.clear();
  });
  it("rechecks authorization, reuses unchanged bytes and falls back on denial", async () => {
    vi.useFakeTimers();
    const io = urls(), load = vi.fn().mockResolvedValueOnce(photo()).mockImplementationOnce(async (_id, _signal, previous) => previous).mockRejectedValueOnce(Error("forbidden"));
    const store = createAvatarStore(load, io); store.subscribe("a", vi.fn()); await tick();
    vi.advanceTimersByTime(60_000); store.refresh(); await tick(); expect(io.create).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000); store.refresh(); await tick(); expect(store.getURL("a")).toBe(""); expect(io.revoke).toHaveBeenCalledOnce(); store.clear();
  });
  it("expires an already loaded image and bounds simultaneous requests", async () => {
    vi.useFakeTimers(); const io = urls(), store = createAvatarStore(async () => photo("a", Date.now() + 1000), io);
    store.subscribe("a", vi.fn()); await tick(); vi.advanceTimersByTime(1000); expect(store.getURL("a")).toBe(""); store.clear();
    const load = vi.fn(() => new Promise<null>(() => {})), queued = createAvatarStore(load, io);
    for (let i = 0; i < 20; i++) queued.subscribe(String(i), vi.fn());
    expect(load).toHaveBeenCalledTimes(4); queued.clear();
  });
});

const id = "00000000-0000-4000-8000-000000000001", photoId = "00000000-0000-4000-8000-000000000002";
function reader() {
  const profile = { context: { kind: "profile", id, authorId: id } } as EncryptedEnvelope;
  const media = { context: { kind: "media", id: photoId, authorId: id, parentId: id, groupId: null, expiresAt: null } } as EncryptedEnvelope;
  return { profile, media, viewerId: id, read: vi.fn(async (path: string) => path.includes("/media/") ? media : { envelope: profile }) as any,
    open: vi.fn(async (row: { id: string }) => row.id === id ? { avatar: { id: photoId } } : { mime: "image/jpeg", bytes: "synthetic" }) as any,
    validate: vi.fn(async () => new Blob(["safe pixels"])) };
}
describe("authorized profile photo loading", () => {
  it("opens the signed profile and its owned media, never a public image URL", async () => {
    const io = reader(), signal = new AbortController().signal;
    expect(await readAvatarPhoto(id, signal, undefined, io)).toMatchObject({ photoId, expiresAt: null, blob: expect.any(Blob) });
    expect(io.read.mock.calls.map((v: any) => v[0])).toEqual(["/me", `/media/${photoId}/bytes`]);
    expect(io.open).toHaveBeenLastCalledWith({ id: photoId, author_id: id, envelope: io.media });
    io.read.mockClear(); io.viewerId = "someone-else";
    await readAvatarPhoto(id, signal, { photoId, expiresAt: null }, io);
    expect(io.read.mock.calls.map((v: any) => v[0])).toEqual([`/profiles/member/${id}`]);
  });
  it.each(["kind", "authorId", "parentId", "groupId", "id"])("rejects mismatched media %s before decryption", async key => {
    const io = reader(); (io.media.context as any)[key] = "wrong";
    await expect(readAvatarPhoto(id, new AbortController().signal, undefined, io)).rejects.toThrow("identity");
    expect(io.open).toHaveBeenCalledTimes(1); expect(io.validate).not.toHaveBeenCalled();
  });
  it("does not fetch a photo if the profile is unavailable, removed, malformed or canceled", async () => {
    const io = reader(), signal = new AbortController().signal;
    io.read.mockResolvedValueOnce({}); expect(await readAvatarPhoto(id, signal, undefined, io)).toBeNull();
    io.open.mockResolvedValueOnce({}); expect(await readAvatarPhoto(id, signal, undefined, io)).toBeNull();
    io.open.mockResolvedValueOnce({ avatar: { id: "../../other" } }); await expect(readAvatarPhoto(id, signal, undefined, io)).rejects.toThrow("reference");
    const canceled = new AbortController(); canceled.abort(); await expect(readAvatarPhoto(id, canceled.signal, undefined, io)).rejects.toThrow();
    expect(io.validate).not.toHaveBeenCalled();
  });
});
