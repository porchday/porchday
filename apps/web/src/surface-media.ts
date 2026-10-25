import type { Content, MediaPayload } from "./api";
import type { PendingAsset } from "./Media";

export type SurfaceSlot = "avatar" | "cover" | "background" | "image";
export const PROFILE_SLOTS = ["avatar", "cover", "background"] as const;

/** Build a save draft without changing the displayed, already-saved record. */
export function planSurfacePhotos(
  current: Content,
  slots: readonly SurfaceSlot[],
  selected: Partial<Record<SurfaceSlot, PendingAsset | null>>,
  removed: Partial<Record<SurfaceSlot, boolean>>,
) {
  const payload = { ...current };
  const uploads: { slot: SurfaceSlot; asset: PendingAsset | MediaPayload }[] =
    [];
  const remove_media: { id: string; slot: SurfaceSlot }[] = [];
  for (const slot of slots) {
    const saved = current[slot] as MediaPayload | undefined;
    // Choosing a replacement supersedes an earlier removal choice.
    if (removed[slot] && !selected[slot]) {
      delete payload[slot];
      if (saved) remove_media.push({ id: saved.id, slot });
    } else {
      const asset = selected[slot] || saved;
      if (asset) uploads.push({ slot, asset });
    }
  }
  return { payload, uploads, remove_media };
}
