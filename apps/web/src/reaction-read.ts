import { reactionTag, type EncryptedEnvelope } from "@porchday/crypto";
import {
  validateReactionPayload,
  type ReactionPayload,
} from "@porchday/crypto/reactions";
import type { Json } from "./api";

export type DecodedReaction = {
  memberId: string;
  tag: string;
  payload: ReactionPayload;
};
/** Four bounded decrypt/decoder workers, with cancellation between every step. */
export async function decodeReactions(
  rows: Json[],
  targetId: string,
  secret: string,
  io: {
    open: (row: {
      envelope: EncryptedEnvelope;
      id: string;
      author_id: string;
    }) => Promise<unknown>;
    image: (
      payload: Extract<ReactionPayload, { custom: unknown }>,
    ) => Promise<void>;
    current: () => boolean;
  },
): Promise<DecodedReaction[]> {
  const result: (DecodedReaction | null)[] = Array(rows.length).fill(null);
  let next = 0;
  async function worker() {
    while (io.current() && next < rows.length) {
      const index = next++,
        row = rows[index];
      try {
        const context = row.envelope?.context,
          memberId = row.member_id ?? context?.authorId,
          tag = row.reaction_tag;
        if (
          typeof memberId !== "string" ||
          typeof tag !== "string" ||
          context?.authorId !== memberId ||
          context.kind !== "reaction" ||
          context.parentId !== targetId ||
          context.id !== tag
        )
          continue;
        const plaintext = await io.open({
          envelope: row.envelope,
          id: tag,
          author_id: memberId,
        });
        if (!io.current()) return;
        const payload = await validateReactionPayload(plaintext);
        if (!io.current()) return;
        if (
          (await reactionTag({
            secret,
            targetId,
            memberId,
            emoji: payload.emoji,
          })) !== tag ||
          !io.current()
        )
          continue;
        if ("custom" in payload) await io.image(payload);
        if (io.current()) result[index] = { memberId, tag, payload };
      } catch {
        /* Invalid, expired or undecryptable reactions never count. */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  if (!io.current()) return [];
  const seen = new Set<string>();
  return result.filter((entry): entry is DecodedReaction => {
    if (!entry) return false;
    const key = entry.memberId + ":" + entry.payload.emoji;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
