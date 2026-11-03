import {openPhoto} from "./photo-record";
import {createPhotoProof,photoBytesHash,photoMetadata} from "@porchday/crypto/photos";
import { bytesToBase64, canonicalJson, type Audience } from "@porchday/crypto";
import { ApiError, get, post, request, type MediaPayload } from "./api";
import type { PersonTag } from "./PeopleTags";
import type { useVault } from "./vault";
export type PhotoDraft={id:string;name:string;alt:string;blob:Blob;width:number;height:number;mime?:string;poster?:string;tags?:PersonTag[];photoDate?:string};
export function localPhotoDate(date=new Date()) {
  return `${date.getFullYear().toString().padStart(4,"0")}-${(date.getMonth()+1).toString().padStart(2,"0")}-${date.getDate().toString().padStart(2,"0")}`;
}
/** Stable draft IDs let a retry reconcile an ambiguous publication response. */
export async function publishPhoto(vault:ReturnType<typeof useVault>,photo:PhotoDraft,audience:Audience,expiresAt:string|null,album:string|null) {
  const photoDate=photo.photoDate||localPhotoDate();
  const sourceBytes=new Uint8Array(await photo.blob.arrayBuffer());
  const sha256=await photoBytesHash(sourceBytes);
  async function existing(){
    try{
      const result=await get("/photos/"+photo.id);
      if(result.photo.owner_id!==vault.member.id)throw Error("This photo identity is already in use.");
      if(!result.photo.grants.some((g:any)=>g.album_id===null&&g.audience===audience)||Boolean(album)!==result.photo.grants.some((g:any)=>g.album_id===album&&album!==null))throw Error("This photo was already shared with a different audience. Open it in Feed → Photos to review its sharing.");
      const grant=result.photo.grants.find((g:any)=>g.album_id===album)||result.photo.grants[0];
      const content=await openPhoto(vault,result.photo,grant);
      if((content.photoProof as any)?.statement?.sha256!==sha256||result.photo.photo_date!==photoDate||content.media?.[0]?.alt!==photo.alt||canonicalJson(content.media?.[0]?.tags||[])!==canonicalJson(photo.tags||[])||(result.photo.expires_at?Date.parse(result.photo.expires_at):null)!==(expiresAt?Date.parse(expiresAt):null))throw Error("This photo was already shared before the connection was lost. Open it in Feed → Photos to edit it.");
      return true;
    }catch(error){if(error instanceof ApiError&&error.status===404)return false;throw error;}
  }
  if(await existing())return;
  const createdAt=new Date().toISOString();
  const destinations=[{audience,groupId:null as string|null},...(album?[{audience:"album" as Audience,groupId:album}]:[])];

  const grants=[];
  for(const destination of destinations){
    const media:MediaPayload={id:crypto.randomUUID(),name:photo.name,alt:photo.alt,width:photo.width,height:photo.height,mime:photo.mime||"image/jpeg",tags:photo.tags||[],...(photo.poster?{poster:photo.poster,posterExpiresAt:expiresAt}:{})};
    const encrypted=await vault.seal({...media,bytes:bytesToBase64(sourceBytes)},{id:media.id,kind:"media",parentId:photo.id,...destination,createdAt,expiresAt});
    const bytes=new TextEncoder().encode(JSON.stringify(encrypted));
    if(bytes.length>22_020_096)throw Error("This encrypted photo is too large for this audience. Choose a smaller file.");
    const upload=await post("/media",{id:media.id,envelope:encrypted,byte_size:bytes.length});
    await request(upload.upload_url,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:new Blob([bytes])});
    const photoProof=await createPhotoProof({photoId:photo.id,ownerId:vault.member.id,deviceId:vault.device.id,revision:1,date:photoDate,expiresAt,sha256,metadata:photoMetadata(media)},vault.privateKey);
    const envelope=await vault.seal({media:[media],photoProof},{id:crypto.randomUUID(),kind:"photo",parentId:photo.id,...destination,createdAt,expiresAt,photoDate});
    grants.push({envelope,media_id:media.id});
  }
  try{await post("/photos",{id:photo.id,photo_date:photoDate,expires_at:expiresAt,grants});}
  catch(error){
    // A committed publication must not be repeated after a lost response.
    // If reconciliation itself is unavailable, retain the draft and its ID.
    if(await existing())return;throw error;
  }
}
