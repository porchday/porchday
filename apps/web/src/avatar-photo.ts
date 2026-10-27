import type { Content, EncryptedEnvelope } from "./api";
import type { AvatarPhoto } from "./avatar-store";

type Reader = {
  viewerId: string;
  read: <T>(path: string, signal: AbortSignal) => Promise<T>;
  open: (row: { id: string; author_id: string; envelope: EncryptedEnvelope }) => Promise<Content>;
  validate: (encoded: string) => Promise<Blob>;
};
/** A post's audience never grants access to its author's private profile. */
export async function readAvatarPhoto(memberId: string, signal: AbortSignal, previous: AvatarPhoto | undefined, io: Reader): Promise<AvatarPhoto | null> {
  const profile = await io.read<{ envelope?: EncryptedEnvelope }>(memberId === io.viewerId ? "/me" : `/profiles/member/${memberId}`, signal);
  if (!profile.envelope) return null;
  if (profile.envelope.context.kind !== "profile" || profile.envelope.context.id !== memberId || profile.envelope.context.authorId !== memberId)
    throw Error("Profile identity did not match.");
  const payload = await io.open({ id: memberId, author_id: memberId, envelope: profile.envelope });
  signal.throwIfAborted();
  const photoId = payload.avatar?.id;
  if (!photoId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(photoId)) throw Error("Invalid photo reference.");
  // Media IDs are immutable. Recheck profile authorization each minute without
  // downloading an unchanged photo for every post or refresh.
  if (previous?.photoId === photoId && (previous.expiresAt === null || previous.expiresAt > Date.now())) return previous;
  const envelope = await io.read<EncryptedEnvelope>(`/media/${photoId}/bytes`, signal);
  if (envelope.context.kind !== "media" || envelope.context.id !== photoId || envelope.context.authorId !== memberId || envelope.context.parentId !== memberId || envelope.context.groupId !== null)
    throw Error("Profile photo identity did not match.");
  const content = await io.open({ id: photoId, author_id: memberId, envelope });
  if (content.mime !== "image/jpeg" || typeof content.bytes !== "string") throw Error("Unsupported photo format.");
  const expiresAt = envelope.context.expiresAt === null ? null : Date.parse(envelope.context.expiresAt);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return null;
  const blob = await io.validate(content.bytes);
  signal.throwIfAborted();
  return { photoId, expiresAt, blob };
}
