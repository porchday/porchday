import { describe, it, expect } from "vitest";
import { zipSync, strToU8, strFromU8, unzipSync } from "fflate";
import {
  emptyArchive,
  packArchive,
  unpackArchive,
  validateSet,
  eligibleEntries,
  checksum,
} from "../src/archive";
const member = "11111111-1111-4111-8111-111111111111";
const entry = {
  id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-01-01T12:00:00.000Z",
  expires_at: null,
  audience: "connections",
  parent_id: null,
  group_id: null,
  payload: { text: "A little memory", media: [] },
};
describe("portable archive privacy and integrity", () => {
  it("round-trips profile fields and authored content without importing private account credentials", () => {
    const archive = emptyArchive(member, "gardenfriend");
    archive.profile = {
      displayName: "Jane",
      theme: "sage",
      bio: "Books and gardens",
    };
    archive.posts.push(entry);
    const decoded = unpackArchive(packArchive(archive)).archive;
    expect(decoded.profile).toEqual(archive.profile);
    expect(decoded.posts).toEqual([entry]);
    expect(decoded).not.toHaveProperty("password");
    expect(decoded).not.toHaveProperty("session");
  });
  it("escapes authored text in the readable HTML instead of running it", () => {
    const archive = emptyArchive(member, "<script>");
    archive.posts.push({
      ...entry,
      payload: { text: "<img src=x onerror=alert(1)>", media: [] },
    });
    const html = strFromU8(unzipSync(packArchive(archive))["index.html"]);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });
  it("rejects path traversal and archives that expand beyond the limit", () => {
    const archive = emptyArchive(member, "friend");
    expect(() =>
      unpackArchive(
        zipSync({
          "archive.json": strToU8(JSON.stringify(archive)),
          "../outside": strToU8("bad"),
        }),
      ),
    ).toThrow(/unsafe paths/);
    const expanded = new Uint8Array(36 * 1024 * 1024);
    expect(() =>
      unpackArchive(
        zipSync({
          "archive.json": strToU8(JSON.stringify(archive)),
          oversized: expanded,
        }),
      ),
    ).toThrow(/safe expansion/);
  });
  it("requires the complete multipart set and rejects duplicate or mixed parts", () => {
    const one = emptyArchive(member, "friend", {
      id: "set-one",
      index: 1,
      total: null,
    });
    const two = emptyArchive(member, "friend", {
      id: "set-one",
      index: 2,
      total: 2,
      complete: true,
    });
    expect(() => validateSet([one, two])).not.toThrow();
    expect(() => validateSet([one])).toThrow(/completion/);
    expect(() => validateSet([two])).toThrow(/2 parts/);
    expect(() =>
      validateSet([
        one,
        {
          ...one,
          archive_set: { id: "other", index: 2, total: 2, complete: true },
        },
      ]),
    ).toThrow(/different archive sets/);
    expect(() =>
      validateSet([
        one,
        {
          ...two,
          archive_set: { id: "set-one", index: 1, total: 2, complete: true },
        },
      ]),
    ).toThrow(/missing or duplicated/);
  });
  it("keeps each part readable after extracting into one folder", () => {
    const part = emptyArchive(member, "friend", {
      id: "set",
      index: 2,
      total: 2,
      complete: true,
    });
    const files = unzipSync(packArchive(part));
    expect(files["index-part-002.html"]).toBeTruthy();
    expect(files["archive-part-002.json"]).toBeTruthy();
    expect(strFromU8(files["index.html"])).toContain("index-part-001.html");
  });
  it("preserves comments and reactions as journal records and never resurrects expired entries", () => {
    const part = emptyArchive(member, "friend");
    part.posts = [{ ...entry, expires_at: "2026-01-02T00:00:00.000Z" }];
    part.comments = [
      { ...entry, id: "comment", parent_id: "unavailable-parent" },
    ];
    part.reactions = [{ ...entry, id: "reaction", payload: { emoji: "love" } }];
    const entries = eligibleEntries([part], Date.parse("2026-10-25T00:00:00Z"));
    expect(entries).toHaveLength(2);
    expect(entries[0].journal_kind).toBe("comment");
    expect(entries[0].parent_id).toBe("unavailable-parent");
    expect(entries[1].payload.emoji).toBe("love");
  });
  it("checks exact photo bytes using a stable standard SHA256 checksum", async () => {
    expect(await checksum(strToU8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const part = emptyArchive(member, "friend");
    part.media = [
      {
        id: "photo",
        path: "photos/photo.jpg",
        mime: "image/jpeg",
        sha256: "bad",
      },
    ];
    expect(() => unpackArchive(packArchive(part))).toThrow(
      /missing or malformed/,
    );
  });
});
