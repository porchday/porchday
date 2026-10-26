import { describe, it, expect, vi } from "vitest";
import { createReactionSecret, reactionTag } from "@porchday/crypto";
import {
  unicodeReaction,
  type ReactionPayload,
} from "@porchday/crypto/reactions";
import { decodeReactions } from "../src/reaction-read";
import { custom } from "./emoji-fixtures";
const secret = createReactionSecret();
async function row(
  payload: ReactionPayload,
  member = "alice",
  target = "post",
) {
  const tag = await reactionTag({
    secret,
    targetId: target,
    memberId: member,
    emoji: payload.emoji,
  });
  return {
    member_id: member,
    reaction_tag: tag,
    payload,
    envelope: {
      context: {
        authorId: member,
        kind: "reaction",
        parentId: target,
        id: tag,
      },
    },
  };
}
describe("bounded verified reaction reader", () => {
  it("renders nonlegacy Unicode/custom choices and multiple choices per member while removing duplicates", async () => {
    const unicode = await unicodeReaction("🦦"),
      image = await custom();
    const rows = await Promise.all([
      row({ emoji: "like" }),
      row(unicode),
      row(image),
      row(unicode),
      row(unicode, "bob"),
    ]);
    const io = {
      open: vi.fn(
        async ({ id, author_id }) =>
          rows.find(
            (value) =>
              value.reaction_tag === id && value.member_id === author_id,
          )!.payload,
      ),
      image: vi.fn(async () => {}),
      current: () => true,
    };
    const result = await decodeReactions(rows, "post", secret, io);
    expect(result.map((value) => value.payload.emoji)).toEqual([
      "like",
      unicode.emoji,
      image.emoji,
      unicode.emoji,
    ]);
    expect(io.image).toHaveBeenCalledWith(image);
    expect(io.open).toHaveBeenCalledWith(
      expect.objectContaining({ author_id: "bob" }),
    );
  });
  it("rejects cross-target, foreign-author, wrong-tag and forged descriptors", async () => {
    const valid = await row(await unicodeReaction("🦦")),
      other = await row({ emoji: "love" }, "alice", "other");
    const wrongAuthor = { ...valid, member_id: "bob" },
      wrongTag = { ...valid, reaction_tag: "wrong" };
    const io = {
      open: vi.fn(async () => ({ emoji: valid.payload.emoji, unicode: "🌻" })),
      image: vi.fn(async () => {}),
      current: () => true,
    };
    expect(
      await decodeReactions(
        [other, wrongAuthor, wrongTag, valid],
        "post",
        secret,
        io,
      ),
    ).toEqual([]);
    expect(io.open).toHaveBeenCalledOnce();
    io.open.mockResolvedValue({ emoji: "like" } as any);
    expect(await decodeReactions([valid], "post", secret, io)).toEqual([]);
  });
  it("limits asynchronous decrypts to four and stops publishing after cancellation", async () => {
    const rows = await Promise.all(
      Array.from({ length: 13 }, (_, index) =>
        row({ emoji: "like" }, `member${index}`),
      ),
    );
    let inflight = 0,
      maximum = 0,
      current = true;
    const io = {
      open: vi.fn(async () => {
        inflight++;
        maximum = Math.max(maximum, inflight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inflight--;
        return { emoji: "like" };
      }),
      image: vi.fn(async () => {}),
      current: () => current,
    };
    expect(await decodeReactions(rows, "post", secret, io)).toHaveLength(13);
    expect(maximum).toBe(4);
    io.open.mockImplementation(async () => {
      current = false;
      return { emoji: "like" };
    });
    expect(await decodeReactions(rows, "post", secret, io)).toEqual([]);
  });
  it("does not count an undecodable custom image", async () => {
    const value = await row(await custom());
    expect(
      await decodeReactions([value], "post", secret, {
        open: async () => value.payload,
        image: async () => {
          throw new Error("PNG decode failed");
        },
        current: () => true,
      }),
    ).toEqual([]);
  });
});
