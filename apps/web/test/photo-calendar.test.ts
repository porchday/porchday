import { describe, it, expect } from "vitest";
import {
  localDay,
  monthCells,
  monthRange,
  featuredEntry,
  filterEntries,
  type CalendarEntry,
} from "../src/photo-calendar";
import { validTags } from "../src/PeopleTags";
function entry(
  id: string,
  author = "a",
  text = "A moment",
  media = false,
  tags: unknown = [],
): CalendarEntry {
  return {
    row: {
      id,
      author_id: author,
      created_at: "2026-10-01T12:00:00Z",
      expires_at: null,
    } as any,
    content: {
      text,
      tags,
      media: media
        ? [
            {
              id: id + "photo",
              alt: "",
              name: "",
              mime: "image/jpeg",
              width: 1,
              height: 1,
            },
          ]
        : [],
    },
  };
}
describe("personal photo calendar", () => {
  it("uses local month boundaries including leap years and complete weeks", () => {
    expect(monthCells(2024, 1).filter(Boolean)).toHaveLength(29);
    expect(monthCells(2026, 1).filter(Boolean)).toHaveLength(28);
    expect(monthCells(2026, 10).length % 7).toBe(0);
    const range = monthRange(2026, 10);
    expect(new Date(range.start).getDate()).toBe(1);
    expect(new Date(range.end).getMonth()).toBe(11);
    expect(localDay(new Date(2026, 9, 31, 23, 59))).toBe("2026-10-31");
  });
  it("prefers a photo and falls back when a personal highlight is inaccessible or filtered", () => {
    const a = entry("a"),
      b = entry("b", "b", "", true);
    expect(featuredEntry([a, b])?.entry).toBe(b);
    expect(featuredEntry([a, b], { post_id: "a", media_id: null })?.entry).toBe(
      a,
    );
    expect(featuredEntry([b], { post_id: "a", media_id: null })?.entry).toBe(b);
    expect(featuredEntry([])).toBeNull();
  });
  it("combines author and encrypted tags without expanding visibility and removes expired rows", () => {
    const tag = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "child",
      label: "Child",
    };
    const a = entry("a", "a", "Hi", false, [tag]),
      b = entry("b", "b", "Hi", false, [tag]),
      c = entry("c", "a");
    expect(filterEntries([a, b, c], "a", ["child:" + tag.id])).toEqual([a]);
    a.row.expires_at = "2020-01-01T00:00:00Z";
    expect(filterEntries([a], "", [])).toEqual([]);
  });
  it("finds photo caption tags and tolerates old payloads", () => {
    const tag = {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "member" as const,
      label: "friend",
    };
    const photo = entry("p", "a", "", true);
    photo.content.media![0].tags = [tag];
    expect(
      filterEntries([photo, entry("old")], "", ["member:" + tag.id]),
    ).toEqual([photo]);
    expect(validTags({})).toEqual([]);
    expect(
      validTags([{ id: "../../evil", kind: "member", label: "bad" }]),
    ).toEqual([]);
  });
});
