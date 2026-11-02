import type { Content, EncryptedEnvelope } from "./api";
import type { useVault } from "./vault";
export type PhotoGrant={id:string;photo_id:string;album_id:string|null;audience:string;envelope:EncryptedEnvelope;media_id:string};
export type PhotoRow={id:string;owner_id:string;photo_date:string;revision:number;created_at:string;expires_at:string|null;grants:PhotoGrant[]};
export async function openPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,grant:PhotoGrant){
  const context=grant.envelope.context;
  if(context.kind!=="photo"||context.id!==grant.id||context.parentId!==photo.id||context.photoDate!==photo.photo_date||context.revision!==photo.revision)throw Error("Photo identity or date did not match its signed metadata.");
  const content=await vault.open({id:grant.id,author_id:photo.owner_id,envelope:grant.envelope});
  if(content.media?.length!==1||content.media[0].id!==grant.media_id)throw Error("Photo attachment did not match its signed metadata.");
  return content;
}
