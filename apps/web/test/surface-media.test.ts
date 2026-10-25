import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { planSurfacePhotos, PROFILE_SLOTS } from "../src/surface-media";
import type { MediaPayload } from "../src/api";
import type { PendingAsset } from "../src/Media";
vi.mock("../src/vault", () => ({
  useVault: () => ({ member: { id: "member", handle: "member" } }),
}));
import { AssetPicker } from "../src/Media";

const photo = (id: string): MediaPayload => ({
  id,
  alt: "A little garden",
  name: "garden.jpg",
  width: 400,
  height: 300,
  mime: "image/jpeg",
});
const pending: PendingAsset = {
  ...photo("replacement"),
  slot: "avatar",
  preview: "data:image/jpeg;base64,test",
  blob: new Blob(),
};

describe("explicit profile and group photo removal", () => {
  it("omits only selected photo references and sends the exact original IDs and slots", () => {
    const current = {
      displayName: "Jane",
      avatar: photo("avatar-original"),
      cover: photo("cover-original"),
      background: photo("background-original"),
      theme: "sage",
    };
    const plan = planSurfacePhotos(
      current,
      PROFILE_SLOTS,
      {},
      { avatar: true, background: true },
    );
    expect(plan.payload).toEqual({
      displayName: "Jane",
      cover: current.cover,
      theme: "sage",
    });
    expect(plan.remove_media).toEqual([
      { id: "avatar-original", slot: "avatar" },
      { id: "background-original", slot: "background" },
    ]);
    expect(plan.uploads).toEqual([{ slot: "cover", asset: current.cover }]);
    // The saved record remains intact until the revised envelope commits.
    expect(current.avatar.id).toBe("avatar-original");
    expect(current.background.id).toBe("background-original");
  });
  it("undo preserves the current image and choosing a replacement cancels removal", () => {
    const current = { avatar: photo("original") };
    const undo = planSurfacePhotos(
      current,
      PROFILE_SLOTS,
      {},
      { avatar: false },
    );
    expect(undo.remove_media).toEqual([]);
    expect(undo.uploads[0].asset).toBe(current.avatar);
    const replace = planSurfacePhotos(
      current,
      PROFILE_SLOTS,
      { avatar: pending },
      { avatar: true },
    );
    expect(replace.remove_media).toEqual([]);
    expect(replace.uploads).toEqual([{ slot: "avatar", asset: pending }]);
  });
  it("removes a group image without replacing it or changing the group’s other encrypted fields", () => {
    const current = {
      image: photo("other-editor-photo"),
      name: "Book club",
      description: "Thursday evenings",
    };
    const plan = planSurfacePhotos(current, ["image"], {}, { image: true });
    expect(plan.payload).toEqual({
      name: "Book club",
      description: "Thursday evenings",
    });
    expect(plan.uploads).toEqual([]);
    expect(plan.remove_media).toEqual([
      { id: "other-editor-photo", slot: "image" },
    ]);
  });
  it("does not invent a deletion for an empty slot", () => {
    const plan = planSurfacePhotos({}, PROFILE_SLOTS, {}, { cover: true });
    expect(plan.remove_media).toEqual([]);
    expect(plan.uploads).toEqual([]);
  });
  it("offers a distinct named remove control for an existing photo, including unavailable images", () => {
    const html = renderToStaticMarkup(
      createElement(AssetPicker, {
        slot: "avatar",
        label: "Profile photo",
        asset: null,
        current: photo("expired-or-current"),
        onChange() {},
        onRemovalChange() {},
      }),
    );
    expect(html).toContain('aria-label="Remove current profile photo"');
    expect(html).toContain("Remove current photo");
    expect(html).not.toContain("Undo removal");
    expect(html).not.toContain('data-unsaved-draft="true"');
  });
  it("makes removal reviewable and reversible before save, and disables it during a pending save", () => {
    const html = renderToStaticMarkup(
      createElement(AssetPicker, {
        slot: "image",
        label: "Group image",
        asset: null,
        current: photo("group-image"),
        removed: true,
        disabled: true,
        onChange() {},
        onRemovalChange() {},
      }),
    );
    expect(html).toContain("will be removed when you save");
    expect(html).toContain("Undo removal");
    expect(html).toContain('data-unsaved-draft="true"');
    expect(html).toMatch(
      /disabled=""[^>]*aria-label="Undo removal of group image"/,
    );
    expect(html).not.toContain("Opening encrypted photo");
  });
});
