import { describe, expect, it, vi } from "vitest";
import { preparePostAudienceRefresh, startPostAudienceRefresh, type PreparedAudienceRefresh, type RefreshPost } from "../src/post-audience-refresh";
import { ApiError, type Content, type ContentContext, type EncryptedEnvelope } from "../src/api";
import { decryptObject, encryptObject, generateDeviceKeys, signStatement, unlockPrivateKey } from "@porchday/crypto";

const created = "2026-01-01T00:00:00.000Z", expires = "2030-01-01T00:00:00.000Z";
const now = Date.parse("2026-10-27T00:00:00.000Z");
const context = (patch: Partial<ContentContext> = {}): ContentContext => ({ id: "post", kind: "post", authorId: "author", authorDeviceId: "old-device", audience: "connections", parentId: null, groupId: null, epoch: 1, revision: 4, createdAt: created, expiresAt: expires, ...patch });
const envelope = (patch: Partial<ContentContext> = {}, ciphertext = "original"): EncryptedEnvelope => ({ v: 1, protocol: "porchday-openpgp-v1", context: context(patch), recipients: [{ memberId: "author", deviceId: "old-device", fingerprint: "author-key" }], ciphertext });
function source(): RefreshPost {
  return { id: "post", author_id: "author", created_at: created, expires_at: expires, audience: "connections", group_id: null, envelope: envelope(), media: [] };
}
function fixture(row = source(), content: Content = { text: "Original text", reactionSecret: "same-reaction-secret" }) {
  let sequence = 0;
  const sealed: { payload: Content; context: ContentContext }[] = [];
  const cleanup = vi.fn(async (_ids: string[]) => {});
  const upload = vi.fn(async (_id: string, _envelope: EncryptedEnvelope, _revision: number) => {});
  const prepareAudience = vi.fn(async () => async (payload: Content, context: ContentContext) => {
    sealed.push({ payload, context }); return { ...envelope(), context: { ...context, epoch: 7 }, ciphertext: `fresh-${++sequence}` };
  });
  const io = {
    memberId: "author", deviceId: "new-device", current: () => true, now: () => now,
    newId: () => `replacement-${++sequence}`,
    readPost: vi.fn(async () => row), open: vi.fn(async (value: { id: string }) => value.id === "post" ? content : { id: value.id, mime: "image/jpeg", bytes: "photo-bytes" }),
    prepareAudience, readMedia: vi.fn(async (id: string) => envelope({ id, kind: "media", parentId: "post", expiresAt: "2029-01-01T00:00:00.000Z" }, `cipher-${id}`)),
    validatePhoto: vi.fn(async () => {}), upload, cleanup, sign: vi.fn(async (statement: unknown) => ({ statement, signature: "signature" })),
  };
  return { row, content, io, sealed, upload, cleanup, prepareAudience };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };

describe("author-consented historical post preparation", () => {
  it("keeps the same post/date/deadline/reaction namespace and uses only the history snapshot", async () => {
    const f = fixture();
    const prepared = await preparePostAudienceRefresh("post", f.io, new AbortController().signal);
    expect(prepared.id).toBe("post");
    expect(prepared.body.envelope.context).toEqual(context({ revision: 5, epoch: 7, authorDeviceId: "new-device" }));
    expect(prepared.body.source_revision).toBe(4);
    expect(prepared.body.source_expires_at).toBe(expires);
    expect(f.sealed[0].payload).toEqual({ ...f.content, media: [] });
    expect(f.prepareAudience).toHaveBeenCalledWith(f.row, expect.any(AbortSignal));
    expect(f.io.sign).toHaveBeenCalledWith({ purpose: "porchday-lifecycle", id: "post", revision: 5, expiresAt: expires });
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("creates immutable replacements only for live owned photos, remaps references and preserves shorter deadlines", async () => {
    const photo = { id: "photo", alt: "Garden", mime: "image/jpeg", name: "garden.jpg", width: 100, height: 80 };
    const f = fixture({ ...source(), media: [{ id: "photo", byte_size: 300, envelope: envelope({ id: "photo", kind: "media", parentId: "post" }) }] }, { text: "Original", reactionSecret: "same", media: [photo, { ...photo, id: "expired-photo" }] });
    const prepared = await preparePostAudienceRefresh("post", f.io, new AbortController().signal);
    expect(f.io.readMedia).toHaveBeenCalledTimes(1);
    expect(f.io.readMedia).toHaveBeenCalledWith("photo", expect.any(AbortSignal));
    expect(prepared.body.source_media_ids).toEqual(["photo"]);
    expect(prepared.body.media_ids).toEqual(["replacement-1"]);
    expect(f.sealed[0].context).toMatchObject({ id: "replacement-1", parentId: "post", createdAt: new Date(now).toISOString(), expiresAt: "2029-01-01T00:00:00.000Z", revision: 1 });
    expect(f.sealed[1].payload).toEqual({ text: "Original", reactionSecret: "same", media: [{ ...photo, id: "replacement-1" }] });
    expect(f.upload).toHaveBeenCalledWith("replacement-1", expect.anything(), 4);
    expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("keeps each old photo paired with its replacement when metadata order differs", async () => {
    const photo = { id: "first", alt: "", mime: "image/jpeg", name: "x", width: 1, height: 1 };
    const f = fixture({ ...source(), media: ["second", "first"].map(id => ({ id, byte_size: 300, envelope: envelope() })) }, { media: [photo, { ...photo, id: "second" }] });
    const result = await preparePostAudienceRefresh("post", f.io, new AbortController().signal);
    expect(result.body.source_media_ids).toEqual(["first", "second"]);
    expect(result.body.media_ids).toEqual(["replacement-1", "replacement-3"]);
  });
  it.each([
    { author_id: "someone-else" },
    { audience: "only_me", envelope: envelope({ audience: "only_me" }) },
    { group_id: "group", envelope: envelope({ audience: "group", groupId: "group" }) },
    { expires_at: "2026-01-02T00:00:00.000Z", envelope: envelope({ expiresAt: "2026-01-02T00:00:00.000Z" }) },
  ])("refuses ineligible content before sharing %#", async patch => {
    const f = fixture({ ...source(), ...patch } as RefreshPost);
    await expect(preparePostAudienceRefresh("post", f.io, new AbortController().signal)).rejects.toThrow();
    expect(f.prepareAudience).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("will not silently omit a live attached photo missing from signed plaintext", async () => {
    const f = fixture({ ...source(), media: [{ id: "missing", byte_size: 300, envelope: envelope() }] });
    await expect(preparePostAudienceRefresh("post", f.io, new AbortController().signal)).rejects.toThrow(/photo references/);
    expect(f.prepareAudience).not.toHaveBeenCalled();
  });
  it("cleans only newly reserved unattached IDs after a failed preparation", async () => {
    const photo = { id: "photo", alt: "", mime: "image/jpeg", name: "x", width: 1, height: 1 };
    const f = fixture({ ...source(), media: [{ id: "photo", byte_size: 300, envelope: envelope() }] }, { media: [photo] });
    f.io.upload.mockRejectedValueOnce(Error("upload response lost"));
    await expect(preparePostAudienceRefresh("post", f.io, new AbortController().signal)).rejects.toThrow();
    expect(f.cleanup).toHaveBeenCalledWith(["replacement-1"]);
  });
  it("stops after an account change during encryption and never uses the next account for cleanup", async () => {
    let current = true; const gate = deferred<Content>(); const f = fixture();
    f.io.current = () => current; f.io.open = vi.fn(() => gate.promise);
    const pending = preparePostAudienceRefresh("post", f.io, new AbortController().signal);
    await flush(); current = false; gate.resolve(f.content);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.prepareAudience).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("a missing encryption audience pauses without uploading or writing a post", async () => {
    const f = fixture(); f.io.prepareAudience.mockRejectedValueOnce(Error("A connection still needs to set up encryption."));
    await expect(preparePostAudienceRefresh("post", f.io, new AbortController().signal)).rejects.toThrow(/set up encryption/);
    expect(f.upload).not.toHaveBeenCalled(); expect(f.io.sign).not.toHaveBeenCalled();
  });
  it("makes a real earlier ciphertext readable only to the consented new recipient", async () => {
    const devices = await Promise.all(["author", "full", "future"].map(id => generateDeviceKeys(id, `${id}-device`)));
    const keys = await Promise.all(devices.map(device => unlockPrivateKey(device.encryptedPrivateKey, device.recoverySecret, device.fingerprint)));
    const originalContext = context({ authorDeviceId: "author-device" });
    const recipients = devices.map((device, i) => ({ memberId: ["author", "full", "future"][i], deviceId: `${["author", "full", "future"][i]}-device`, publicKey: device.publicKey }));
    const content = { text: "Earlier post", reactionSecret: "same-secret" };
    const original = await encryptObject({ payload: content, context: originalContext, signingKey: keys[0], recipients: recipients.slice(0, 1) });
    await expect(decryptObject({ envelope: original, expectedContext: original.context, privateKey: keys[1], authorPublicKey: devices[0].publicKey })).rejects.toThrow(/not a recipient/);
    const f = fixture({ ...source(), envelope: original }, content);
    const result = await preparePostAudienceRefresh("post", {
      ...f.io, deviceId: "author-device",
      open: row => decryptObject<Content>({ envelope: row.envelope, expectedContext: row.envelope.context, privateKey: keys[0], authorPublicKey: devices[0].publicKey }),
      prepareAudience: async () => (payload, context) => encryptObject({ payload, context: { ...context, epoch: 8 }, signingKey: keys[0], recipients: recipients.slice(0, 2) }),
      sign: value => signStatement(value, keys[0]),
    }, new AbortController().signal);
    const updated = result.body.envelope;
    expect(updated.context).toMatchObject({ id: original.context.id, createdAt: created, expiresAt: expires, revision: 5 });
    expect(await decryptObject({ envelope: updated, expectedContext: updated.context, privateKey: keys[1], authorPublicKey: devices[0].publicKey })).toEqual({ ...content, media: [] });
    await expect(decryptObject({ envelope: updated, expectedContext: updated.context, privateKey: keys[2], authorPublicKey: devices[0].publicKey })).rejects.toThrow(/not a recipient/);
  });
});

function prepared(): PreparedAudienceRefresh {
  return { id: "post", source: source().envelope, body: { envelope: envelope({ revision: 5 }, "new-cipher"), lifecycle: {}, source_revision: 4, source_expires_at: expires, source_media_ids: [], media_ids: [] } };
}
function runner(overrides: Partial<Parameters<typeof startPostAudienceRefresh>[0]> = {}) {
  const candidate = prepared(), states: string[] = [];
  const io = {
    list: vi.fn(async () => ({ items: [{ id: "post" }] })),
    prepare: vi.fn(async () => candidate), save: vi.fn(async () => {}), read: vi.fn(async () => source()),
    cleanup: vi.fn(async (_ids: string[]) => {}), enabled: () => true,
    state: (state: string) => states.push(state), changed: vi.fn(), ...overrides,
  };
  const task = startPostAudienceRefresh(io);
  return { task, io, states, candidate };
}
describe("bounded history-sharing lifecycle", () => {
  it("deduplicates simultaneous focus/reconnect and never runs overlapping writes", async () => {
    const gate = deferred<void>(); const f = runner({ save: () => gate.promise });
    await flush(); const others = [f.task.recheck(), f.task.recheck(), f.task.retry()];
    expect(f.io.prepare).toHaveBeenCalledTimes(1);
    gate.resolve(); await Promise.all(others); expect(f.io.changed).toHaveBeenCalledTimes(1);
    f.task.dispose();
  });
  it("recognizes a committed write with a lost response without submitting again", async () => {
    const saved = prepared().body.envelope;
    const f = runner({ save: vi.fn(async () => { throw Error("response lost"); }), read: vi.fn(async () => ({ ...source(), envelope: saved })) });
    await flush(); expect(f.io.save).toHaveBeenCalledTimes(1); expect(f.io.changed).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)).toBe("idle"); expect(f.io.cleanup).not.toHaveBeenCalled();
    f.task.dispose();
  });
  it("automatic checks only read after an uncertain write; explicit retry reuses identical bytes", async () => {
    const save = vi.fn().mockRejectedValueOnce(Error("network lost")).mockResolvedValue(undefined);
    const f = runner({ save }); await flush();
    await f.task.recheck(); await f.task.recheck();
    expect(save).toHaveBeenCalledTimes(1); expect(f.io.cleanup).not.toHaveBeenCalled();
    f.io.list.mockResolvedValue({ items: [] });
    await f.task.retry();
    expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0]).toBe(save.mock.calls[0][0]);
    expect(f.io.prepare).toHaveBeenCalledTimes(1); f.task.dispose();
  });
  it("after an audience rejection, requires a fresh snapshot before any later write", async () => {
    const save = vi.fn().mockRejectedValueOnce(new ApiError(409, { error: { code: "AUDIENCE_CHANGED" } })).mockResolvedValue(undefined);
    const f = runner({ save }); await flush(); await f.task.recheck();
    expect(save).toHaveBeenCalledTimes(1); expect(f.states.at(-1)).toBe("unconfirmed");
    await f.task.retry(); expect(f.io.prepare).toHaveBeenCalledTimes(2); f.task.dispose();
  });
  it("does not attach a prepared revision after disposal", async () => {
    const gate = deferred<PreparedAudienceRefresh>(); const f = runner({ prepare: () => gate.promise });
    await flush(); f.task.dispose(); gate.resolve(prepared()); await flush();
    expect(f.io.save).not.toHaveBeenCalled(); expect(f.io.changed).not.toHaveBeenCalled();
  });
  it("suspends hidden-app preparation and resumes on the next foreground check", async () => {
    let visible = true;
    const gate = deferred<PreparedAudienceRefresh>();
    const prepare = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(prepared());
    const f = runner({ enabled: () => visible, prepare });
    await flush(); visible = false; f.task.suspend(); await flush();
    gate.resolve(prepared()); await flush();
    expect(f.io.save).not.toHaveBeenCalled(); expect(f.states.at(-1)).toBe("idle");
    visible = true; await f.task.recheck();
    expect(f.io.save).toHaveBeenCalledTimes(1); f.task.dispose();
  });
  it("never aborts a submitted save when the app becomes hidden", async () => {
    const gate = deferred<void>(); const f = runner({ save: () => gate.promise });
    await flush(); f.task.suspend(); await flush();
    expect(f.io.prepare).toHaveBeenCalledTimes(1);
    gate.resolve(); await f.task.recheck();
    expect(f.io.changed).toHaveBeenCalledTimes(1); f.task.dispose();
  });
  it("allows an already-submitted save to finish but suppresses old-account callbacks", async () => {
    const gate = deferred<void>(); const f = runner({ save: () => gate.promise });
    await flush(); f.task.dispose(); gate.resolve(); await flush();
    expect(f.io.changed).not.toHaveBeenCalled(); expect(f.io.cleanup).not.toHaveBeenCalled();
  });
  it("limits each foreground pass to three posts", async () => {
    const f = runner({ list: async () => ({ items: Array.from({ length: 20 }, (_, i) => ({ id: `post-${i}` })) }) });
    await f.task.recheck();
    expect(f.io.prepare).toHaveBeenCalledTimes(3); f.task.dispose();
  });
});
