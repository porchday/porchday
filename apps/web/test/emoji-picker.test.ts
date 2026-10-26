import { describe, expect, it } from "vitest";
import { searchEmoji } from "../src/EmojiPicker";
import { ApiError } from "../src/api";

describe("bundled Unicode picker", () => {
  it("searches names and canonical native-paste aliases including Unicode 17", () => {
    expect(
      searchEmoji("otter", "", "").some((value) => value.unicode === "🦦"),
    ).toBe(true);
    expect(searchEmoji("1⃣", "", "").map((value) => value.unicode)).toEqual([
      "1️⃣",
    ]);
    expect(searchEmoji("🫩", "", "").map((value) => value.name)).toContain(
      "face with bags under eyes",
    );
    expect(searchEmoji("", "", "")).toHaveLength(3944);
  });
  it("filters actual Unicode categories and mixed skin tone variants without inventing sequences", () => {
    const match = searchEmoji("", "People & Body", "🏽");
    expect(match.length).toBeGreaterThan(100);
    expect(
      match.every(
        (value) =>
          value.group === "People & Body" && value.unicode.includes("🏽"),
      ),
    ).toBe(true);
    expect(
      searchEmoji("", "", "none").every(
        (value) =>
          ![...value.unicode].some(
            (char) =>
              char.codePointAt(0)! >= 0x1f3fb &&
              char.codePointAt(0)! <= 0x1f3ff,
          ),
      ),
    ).toBe(true);
    expect(searchEmoji("not-an-emoji-name", "", "")).toHaveLength(0);
  });
  it("explains per-person and conversation resource limits", () => {
    expect(new ApiError(409, { code: "REACTION_LIMIT" }).message).toBe(
      "You can add up to 20 different reactions here. Remove one before adding another.",
    );
    expect(new ApiError(409, { code: "REACTION_STORAGE_LIMIT" }).message).toBe(
      "This conversation has reached its reaction limit.",
    );
  });
});
