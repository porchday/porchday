import { describe, it, expect, vi, afterEach } from "vitest";
import { reshareDeadline, resharePayload } from "../src/reshare";
import type { SocialObject, Content } from "../src/api";
const source = {
  id: "original-post",
  author_id: "author",
  created_at: "2026-10-01T12:00:00.000Z",
  expires_at: "2026-10-26T12:00:00.000Z",
  audience: "connections",
  group_id: null,
  envelope: { context: { audience: "connections" } },
} as SocialObject;
afterEach(() => vi.useRealTimers());
describe("explicit author resharing", () => {
  it("does not restart or lengthen the original absolute timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    expect(reshareDeadline(source, "inherit", "author")).toBe(
      source.expires_at,
    );
    expect(reshareDeadline(source, "604800", "author")).toBe(source.expires_at);
    expect(reshareDeadline(source, "3600", "author")).toBe(
      "2026-10-25T13:00:00.000Z",
    );
  });
  it("rejects copying another author or an already expired memory", () => {
    expect(() => reshareDeadline(source, "inherit", "someone-else", 0)).toThrow(
      /Only the author/,
    );
    expect(() =>
      reshareDeadline(
        source,
        "inherit",
        "author",
        Date.parse(source.expires_at!),
      ),
    ).toThrow(/expired/);
  });
  it("creates a fresh reaction namespace and excludes original comments and reactions", () => {
    const content = {
      text: "Own text",
      reactionSecret: "old-secret",
      comments: [{ text: "Someone else’s private reply" }],
      reactions: [{ emoji: "love" }],
      media: [{ id: "old-photo" }],
      provenance: { kind: "imported" },
    } as Content;
    const media = [
      {
        id: "new-photo",
        alt: "A garden",
        name: "garden.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
      },
    ];
    const result = resharePayload(source, content, "Own text", media);
    expect(result.text).toBe("Own text");
    expect(result.media).toEqual(media);
    expect(result.reactionSecret).not.toBe("old-secret");
    expect(result).not.toHaveProperty("comments");
    expect(result).not.toHaveProperty("reactions");
    expect(result.provenance).toMatchObject({
      kind: "reshared_post",
      source_id: source.id,
      source_member_id: source.author_id,
      created_at: source.created_at,
      expires_at: source.expires_at,
      prior_provenance: { kind: "imported" },
    });
  });
});
