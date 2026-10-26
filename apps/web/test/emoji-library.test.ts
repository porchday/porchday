import { describe, it, expect, vi } from "vitest";
import type { EncryptedEnvelope } from "@porchday/crypto";
import { ApiError } from "../src/api";
import {
  readEmojiLibrary,
  updateEmojiLibrary,
  validateEmojiLibrary,
  type LibraryIO,
  type EmojiLibrary,
} from "../src/emoji-library";
import { custom } from "./emoji-fixtures";

function libraryStore(initial: EmojiLibrary = { customEmojis: [] }, floor = 0) {
  let envelope: EncryptedEnvelope | null = null,
    revision = floor;
  const make = (payload: EmojiLibrary, context: any): EncryptedEnvelope =>
    ({
      context: {
        authorId: "alice",
        authorDeviceId: "phone",
        epoch: 1,
        ...context,
      },
      recipients: [{ memberId: "alice", deviceId: "phone" }],
      ciphertext: JSON.stringify(payload),
    }) as EncryptedEnvelope;
  if (initial.customEmojis.length)
    envelope = make(initial, {
      kind: "profile",
      id: "alice",
      audience: "only_me",
      parentId: null,
      groupId: null,
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      revision: ++revision,
    });
  const io: LibraryIO = {
    memberId: "alice",
    current: () => true,
    read: vi.fn(async () => ({ envelope, revision })),
    open: vi.fn(async (value) => JSON.parse(value.ciphertext)),
    seal: vi.fn(async (payload, context) => make(payload, context)),
    write: vi.fn(async (next) => {
      envelope = next;
      revision = next.context.revision;
    }),
  };
  return {
    io,
    replace(next: EncryptedEnvelope) {
      envelope = next;
      revision = next.context.revision;
    },
  };
}

describe("private emoji collection", () => {
  it("retains a restored revision floor and encrypts only for the current owner", async () => {
    const { io } = libraryStore(undefined, 12),
      item = await custom();
    const saved = await updateEmojiLibrary(io, { add: [item] });
    expect(saved.revision).toBe(13);
    expect(saved.envelope?.context).toMatchObject({
      id: "alice",
      kind: "profile",
      audience: "only_me",
      parentId: null,
      groupId: null,
      expiresAt: null,
      revision: 13,
    });
    expect(saved.payload.customEmojis).toEqual([item]);
  });
  it("fresh-merges concurrent revisions and preserves existing names for identical bytes", async () => {
    const first = await custom(1, "original"),
      second = await custom(2),
      third = await custom(3);
    const { io } = libraryStore({ customEmojis: [first] });
    const originalWrite = io.write;
    io.write = vi
      .fn()
      .mockImplementationOnce(async () => {
        await updateEmojiLibrary(
          { ...io, write: originalWrite },
          { add: [second] },
        );
        throw new ApiError(409, { code: "REVISION_CHANGED" });
      })
      .mockImplementation(originalWrite);
    const result = await updateEmojiLibrary(io, {
      add: [{ ...first, custom: { ...first.custom, name: "new_name" } }, third],
    });
    expect(result.payload.customEmojis).toEqual([first, second, third]);
    expect(io.write).toHaveBeenCalledTimes(2);
  });
  it("does not replay a write with an unknown result", async () => {
    const { io } = libraryStore();
    io.write = vi.fn(async () => {
      throw new Error("network lost");
    });
    await expect(
      updateEmojiLibrary(io, { add: [await custom()] }),
    ).rejects.toThrow("network lost");
    expect(io.write).toHaveBeenCalledOnce();
  });
  it("bounds conflict retries and never drops entries on capacity overflow", async () => {
    const { io } = libraryStore();
    io.write = vi.fn(async () => {
      throw new ApiError(409, { code: "REVISION_CHANGED" });
    });
    await expect(
      updateEmojiLibrary(io, { add: [await custom()] }),
    ).rejects.toThrow();
    expect(io.write).toHaveBeenCalledTimes(3);
    const full = await Promise.all(
      Array.from({ length: 48 }, (_, i) => custom(i)),
    );
    const store = libraryStore({ customEmojis: full });
    await expect(
      updateEmojiLibrary(store.io, { add: [await custom(99)] }),
    ).rejects.toThrow(/48/);
    expect(store.io.write).not.toHaveBeenCalled();
  });
  it("clears saved images by writing an empty new revision and treats duplicate adds as no-ops", async () => {
    const item = await custom(),
      { io } = libraryStore({ customEmojis: [item] });
    await updateEmojiLibrary(io, { add: [item] });
    expect(io.write).not.toHaveBeenCalled();
    const removed = await updateEmojiLibrary(io, { remove: [item.emoji] });
    expect(removed.payload.customEmojis).toEqual([]);
    expect(removed.revision).toBe(2);
  });
  it("rejects foreign recipients, bad scope, mismatched revision and duplicate image identities", async () => {
    const item = await custom(),
      { io, replace } = libraryStore({ customEmojis: [item] });
    const original = (await io.read()).envelope!;
    for (const context of [
      { parentId: "post" },
      { audience: "connections" },
      { authorId: "bob" },
      { id: "bob" },
      { expiresAt: "2027-01-01T00:00:00Z" },
    ]) {
      replace({
        ...original,
        context: { ...original.context, ...context },
      } as EncryptedEnvelope);
      await expect(readEmojiLibrary(io)).rejects.toThrow(/account only/);
    }
    replace({
      ...original,
      recipients: [{ memberId: "bob", deviceId: "other", fingerprint: "x" }],
    });
    await expect(readEmojiLibrary(io)).rejects.toThrow(/account only/);
    const mismatched = {
      ...io,
      read: async () => ({
        envelope: original,
        revision: original.context.revision + 1,
      }),
    };
    await expect(readEmojiLibrary(mismatched)).rejects.toThrow(/account only/);
    await expect(
      validateEmojiLibrary({ customEmojis: [item, item] }),
    ).rejects.toThrow(/repeated/);
    await expect(
      validateEmojiLibrary({ customEmojis: [{ emoji: "like" }] }),
    ).rejects.toThrow(/invalid/);
  });
  it("stops account-switch work before decrypting or writing", async () => {
    let current = true;
    const { io } = libraryStore({ customEmojis: [await custom()] });
    io.current = () => current;
    const read = io.read;
    io.read = async () => {
      const result = await read();
      current = false;
      return result;
    };
    await expect(readEmojiLibrary(io)).rejects.toThrow(/changed/);
    expect(io.open).not.toHaveBeenCalled();
    current = true;
    io.read = read;
    const seal = io.seal;
    io.seal = async (payload, context) => {
      const result = await seal(payload, context);
      current = false;
      return result;
    };
    await expect(
      updateEmojiLibrary(io, { add: [await custom(2)] }),
    ).rejects.toThrow(/changed/);
    expect(io.write).not.toHaveBeenCalled();
  });
  it("honors an import cancellation predicate while preparing an unsubmitted collection update", async () => {
    const { io } = libraryStore();
    let canceled = false;
    io.current = () => !canceled;
    const seal = io.seal;
    io.seal = async (payload, context) => { const envelope = await seal(payload, context); canceled = true; return envelope; };
    await expect(updateEmojiLibrary(io, { add: [await custom()] })).rejects.toThrow(/changed/);
    expect(io.write).not.toHaveBeenCalled();
  });
});
