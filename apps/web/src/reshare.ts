import { createReactionSecret } from "@porchday/crypto";
import {
  deadline,
  type Content,
  type MediaPayload,
  type SocialObject,
} from "./api";

export function reshareDeadline(
  source: SocialObject,
  choice: string,
  memberId: string,
  now = Date.now(),
) {
  if (source.author_id !== memberId)
    throw new Error("Only the author can share this memory again.");
  const original = source.effective_expires_at || source.expires_at;
  if (original && Date.parse(original) <= now)
    throw new Error("This memory has expired and cannot be shared again.");
  return deadline(choice, original);
}

/** Copy only the author's contribution. A reshare starts a separate conversation. */
export function resharePayload(
  source: SocialObject,
  content: Content,
  text: string,
  media: MediaPayload[],
): Content {
  return {
    text: text.trim(),
    media,
    reactionSecret: createReactionSecret(),
    provenance: {
      kind: "reshared_post",
      source_id: source.id,
      source_member_id: source.author_id,
      created_at: source.created_at,
      expires_at: source.effective_expires_at || source.expires_at,
      original_audience: source.audience || source.envelope.context.audience,
      original_group_id: source.group_id || null,
      prior_provenance: content.provenance || null,
    },
  };
}
