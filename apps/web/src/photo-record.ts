import {verifyPhotoProof,photoMetadata,type PhotoProof} from "@porchday/crypto/photos";
import type { Content, EncryptedEnvelope, Device } from "./api";
import type { useVault } from "./vault";
export type PhotoGrant={author_key:Device;id:string;photo_id:string;album_id:string|null;audience:string;envelope:EncryptedEnvelope;media_id:string};
export type PhotoRow={owner_key:Device;id:string;owner_id:string;photo_date:string;revision:number;created_at:string;expires_at:string|null;grants:PhotoGrant[]};
export async function openPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,grant:PhotoGrant){
  const context=grant.envelope.context;
  if(grant.photo_id!==photo.id||context.groupId!==grant.album_id||context.audience!==grant.audience||context.kind!=="photo"||context.id!==grant.id||context.parentId!==photo.id||context.photoDate!==photo.photo_date||context.revision!==photo.revision)throw Error("Photo identity or date did not match its signed metadata.");
  const content=await vault.open({id:grant.id,author_id:grant.author_key.member_id,author_key:grant.author_key,envelope:grant.envelope});
  if(content.media?.length!==1||content.media[0].id!==grant.media_id)throw Error("Photo attachment did not match its signed metadata.");
  if(photo.owner_key?.member_id!==photo.owner_id)throw Error("Photo owner verification key did not match.");
  await vault.verifyDevice(photo.owner_key);
  await verifyPhotoProof(content.photoProof as PhotoProof,{photoId:photo.id,ownerId:photo.owner_id,deviceId:photo.owner_key.id,revision:photo.revision,date:photo.photo_date,expiresAt:photo.expires_at?new Date(photo.expires_at).toISOString():null,metadata:photoMetadata(content.media[0])},photo.owner_key.public_key);
  return content;
}
