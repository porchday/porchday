import type { ContentContext, EncryptedEnvelope } from "@porchday/crypto";
import {
  validateReactionPayload,
  type ReactionPayload,
} from "@porchday/crypto/reactions";
import { ApiError, request, type Content } from "./api";

export const EMOJI_LIBRARY_LIMIT = 48;
export const EMOJI_LIBRARY_BYTES = 2_150_000;
export type CustomEmoji = Extract<ReactionPayload, { custom: unknown }>;
export type EmojiLibrary = { customEmojis: CustomEmoji[] };
export type LibrarySnapshot = {
  envelope: EncryptedEnvelope | null;
  revision: number;
  payload: EmojiLibrary;
};

export async function validateEmojiLibrary(
  value: unknown,
): Promise<EmojiLibrary> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("This emoji collection is invalid.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "customEmojis") ||
    !Array.isArray(input.customEmojis) ||
    input.customEmojis.length > EMOJI_LIBRARY_LIMIT ||
    new TextEncoder().encode(JSON.stringify(value)).length > EMOJI_LIBRARY_BYTES
  )
    throw new Error(
      "An emoji collection can contain up to 48 images and must fit its storage limit.",
    );
  const customEmojis: CustomEmoji[] = [],
    ids = new Set<string>();
  for (const value of input.customEmojis) {
    const item = await validateReactionPayload(value);
    if (!("custom" in item) || ids.has(item.emoji))
      throw new Error(
        "This emoji collection contains an invalid or repeated image.",
      );
    ids.add(item.emoji);
    customEmojis.push(item);
  }
  return { customEmojis };
}

export type LibraryIO = {
  memberId: string;
  current: () => boolean;
  read: () => Promise<{
    envelope: EncryptedEnvelope | null;
    revision?: number;
  }>;
  open: (envelope: EncryptedEnvelope) => Promise<unknown>;
  seal: (
    payload: EmojiLibrary,
    context: Partial<ContentContext> & { kind: "profile"; audience: "only_me" },
  ) => Promise<EncryptedEnvelope>;
  write: (envelope: EncryptedEnvelope) => Promise<unknown>;
};
function assertCurrent(io: LibraryIO) {
  if (!io.current())
    throw new Error(
      "Your account or unlocked device changed. Open the emoji collection again.",
    );
}
export async function readEmojiLibrary(
  io: LibraryIO,
): Promise<LibrarySnapshot> {
  assertCurrent(io);
  const result = await io.read();
  assertCurrent(io);
  const envelope = result.envelope;
  const revision = result.revision ?? envelope?.context.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error("The emoji collection revision is invalid.");
  if (!envelope)
    return { envelope: null, revision, payload: { customEmojis: [] } };
  const c = envelope.context;
  if (
    c.id !== io.memberId ||
    c.authorId !== io.memberId ||
    c.kind !== "profile" ||
    c.audience !== "only_me" ||
    c.parentId !== null ||
    c.groupId !== null ||
    c.expiresAt !== null ||
    c.revision !== revision ||
    !envelope.recipients.length ||
    envelope.recipients.some((r) => r.memberId !== io.memberId)
  )
    throw new Error(
      "This emoji collection was not encrypted for your account only.",
    );
  const content = await io.open(envelope);
  assertCurrent(io);
  const payload = await validateEmojiLibrary(content);
  assertCurrent(io);
  return { envelope, revision, payload };
}

/** Merge explicit operations into a fresh revision. Never replay unknown writes. */
export async function updateEmojiLibrary(
  io: LibraryIO,
  change: { add?: CustomEmoji[]; remove?: string[] },
): Promise<LibrarySnapshot> {
  const additions = (
    await validateEmojiLibrary({ customEmojis: change.add ?? [] })
  ).customEmojis;
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await readEmojiLibrary(io);
    const remove = new Set(change.remove ?? []);
    const values = new Map(
      old.payload.customEmojis
        .filter((item) => !remove.has(item.emoji))
        .map((item) => [item.emoji, item]),
    );
    for (const item of additions)
      if (!values.has(item.emoji)) values.set(item.emoji, item);
    const payload = await validateEmojiLibrary({
      customEmojis: [...values.values()],
    });
    assertCurrent(io);
    if (JSON.stringify(payload) === JSON.stringify(old.payload)) return old;
    const envelope = await io.seal(payload, {
      kind: "profile",
      id: io.memberId,
      audience: "only_me",
      parentId: null,
      groupId: null,
      expiresAt: null,
      createdAt: old.envelope?.context.createdAt ?? new Date().toISOString(),
      revision: old.revision + 1,
    });
    assertCurrent(io);
    try {
      await io.write(envelope);
    } catch (error) {
      assertCurrent(io);
      if (
        error instanceof ApiError &&
        error.code === "REVISION_CHANGED" &&
        attempt < 2
      )
        continue;
      throw error;
    }
    assertCurrent(io);
    return { envelope, revision: old.revision + 1, payload };
  }
  throw new Error(
    "Your emoji collection changed on another device. Try again.",
  );
}

type LibraryVault = {
  member: { id: string };
  open: (row: {
    envelope: EncryptedEnvelope;
    id?: string;
    author_id?: string;
  }) => Promise<Content>;
  seal: LibraryIO["seal"];
};
export function emojiLibraryIO(
  vault: LibraryVault,
  current: () => boolean,
): LibraryIO {
  return {
    memberId: vault.member.id,
    current,
    read: () => request("/emoji-library"),
    open: (envelope) =>
      vault.open({ envelope, id: vault.member.id, author_id: vault.member.id }),
    seal: (payload, context) => vault.seal(payload, context),
    write: (envelope) =>
      request("/emoji-library", {
        method: "PUT",
        body: JSON.stringify({ envelope }),
      }),
  };
}
