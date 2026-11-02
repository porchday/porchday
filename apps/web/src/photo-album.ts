import {verifyPhotoBytes,type PhotoProof} from "@porchday/crypto/photos";
import {base64ToBytes,type EncryptedEnvelope} from "@porchday/crypto";
import {get,post,request} from "./api";
import type {useVault} from "./vault";
import {validatedMedia} from "./video";
import {openPhoto,type PhotoRow} from "./photo-record";
export async function readOwnedPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow){
 if(photo.owner_id!==vault.member.id)throw Error("Only the photo owner can add it to another album.");
 let last:unknown=Error("Restore the keys for this photo before sharing it.");
 for(const grant of photo.grants){
  try{
   const content=await openPhoto(vault,photo,grant),media=content.media![0];
   const envelope=await get<EncryptedEnvelope>(`/media/${media.id}/bytes`);
   if(envelope.context.kind!=="media"||envelope.context.parentId!==photo.id)throw Error("Photo bytes do not belong to this photo.");
   const payload=await vault.open({id:media.id,envelope});
   if(payload.mime!==media.mime||typeof payload.bytes!=="string")throw Error("Photo bytes do not match the signed metadata.");
   const bytes=base64ToBytes(payload.bytes);await verifyPhotoBytes(content.photoProof as PhotoProof,bytes);
   await validatedMedia(bytes,media.mime);
   return {content,payload};
  }catch(error){last=error;}
 }
 throw last;
}
export async function addPhotoToAlbum(vault:ReturnType<typeof useVault>,photoId:string,albumId:string){
 const current=(await get("/photos/"+photoId)).photo as PhotoRow;
 if(current.owner_id!==vault.member.id)throw Error("Only the photo owner can add it to another album.");
 if(current.grants.some(g=>g.album_id===albumId))return;
 const {content,payload}=await readOwnedPhoto(vault,current);
 const media={...content.media![0],id:crypto.randomUUID()},createdAt=new Date().toISOString();
 const common={audience:"album" as const,groupId:albumId,parentId:photoId,createdAt,expiresAt:current.expires_at};
 const encrypted=await vault.seal({...payload,...media},{...common,id:media.id,kind:"media"});
 const bytes=new TextEncoder().encode(JSON.stringify(encrypted));
 if(bytes.length>22_020_096)throw Error("This encrypted photo is too large for this album's audience.");
 const upload=await post("/media",{id:media.id,envelope:encrypted,byte_size:bytes.length});
 await request(upload.upload_url,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:new Blob([bytes])});
 const envelope=await vault.seal({...content,media:[media]},{...common,id:crypto.randomUUID(),kind:"photo",photoDate:current.photo_date,revision:current.revision});
 try{await post(`/photos/${photoId}/grants`,{envelope,media_id:media.id});}
 catch(error){
  const latest=(await get("/photos/"+photoId)).photo as PhotoRow;
  if(latest.owner_id===vault.member.id&&latest.grants.some(g=>g.album_id===albumId))return;
  throw error;
 }
}
