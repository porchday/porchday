import {diagnosticStep} from './diagnostics';
import {verifyPhotoVideo,uploadPhotoMedia} from './photo-video';
import {verifyPhotoBytes,type PhotoProof} from "@porchday/crypto/photos";
import {canonicalJson,base64ToBytes,type EncryptedEnvelope} from "@porchday/crypto";
import {get,post,request} from "./api";
import type {useVault} from "./vault";
import {validatedMedia} from "./video";
import {openPhoto,type PhotoRow,type PhotoGrant} from "./photo-record";
export async function readOwnedPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow){
 if(photo.owner_id!==vault.member.id)throw Error("Only the photo owner can add it to another album.");
 return readPhoto(vault,photo,photo.grants);
}
async function readPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,grants:PhotoGrant[]){
 let last:unknown=Error("Restore the keys for this photo before sharing it.");
 for(const grant of grants){
  try{
   const content=await openPhoto(vault,photo,grant),media=content.media![0];
   const envelope=await get<EncryptedEnvelope>(`/media/${media.id}/bytes`);
   if(envelope.context.kind!=="media"||envelope.context.parentId!==photo.id)throw Error("Photo bytes do not belong to this photo.");
   const payload=await vault.open({id:media.id,envelope});
   if(payload.mime!==media.mime||typeof payload.bytes!=="string")throw Error("Photo bytes do not match the signed metadata.");
   if(media.videoVersion===3)await verifyPhotoVideo(content.photoProof as PhotoProof,payload.video);
   else{const bytes=base64ToBytes(payload.bytes);await verifyPhotoBytes(content.photoProof as PhotoProof,bytes);await validatedMedia(bytes,media.mime);}
   return {content,payload};
  }catch(error){last=error;}
 }
 throw last;
}
export async function addPhotoToAlbum(vault:ReturnType<typeof useVault>,photoId:string,albumId:string,privateOnly=false){
 const current=(await get("/photos/"+photoId)).photo as PhotoRow;
 if(current.owner_id!==vault.member.id)throw Error("Only the photo owner can add it to another album.");
 if(current.grants.some(g=>g.album_id===albumId))return;
 const {content,payload}=await readOwnedPhoto(vault,current);
 const media={...content.media![0],id:crypto.randomUUID()},createdAt=new Date().toISOString();
 const common={audience:"album" as const,groupId:albumId,parentId:photoId,createdAt,expiresAt:current.expires_at};
 const encrypted=await vault.seal({...payload,...media},{...common,id:media.id,kind:"media"});
 if(privateOnly&&encrypted.recipients.some(r=>r.memberId!==vault.member.id))throw Error("This imported album is now shared. Import stopped before adding private photos.");
 const bytes=new TextEncoder().encode(JSON.stringify(encrypted));
 if(bytes.length>22_020_096)throw Error("This encrypted photo is too large for this album's audience.");
 await uploadPhotoMedia(encrypted,media.videoVersion===3?payload.video:undefined);
 const envelope=await vault.seal({...content,media:[media]},{...common,id:crypto.randomUUID(),kind:"photo",photoDate:current.photo_date,revision:current.revision});
 if(privateOnly&&envelope.recipients.some(r=>r.memberId!==vault.member.id))throw Error("This imported album is now shared. Import stopped before adding private photos.");
 try{await post(`/photos/${photoId}/grants`,{envelope,media_id:media.id});}
 catch(error){
  const latest=(await get("/photos/"+photoId)).photo as PhotoRow;
  if(latest.owner_id===vault.member.id&&latest.grants.some(g=>g.album_id===albumId))return;
  throw error;
 }
}

export async function refreshAlbumPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,albumId:string){
 const grant=photo.grants.find(g=>g.album_id===albumId);if(!grant)throw Error("This album photo is no longer available.");
 return refreshPhotoGrant(vault,photo,grant);
}
export type PreparedPhotoRefresh={id:string;photoId:string;source:EncryptedEnvelope;body:{envelope:EncryptedEnvelope;media_id:string;expected_media_id:string;expected_revision:number}};
export async function preparePhotoRefresh(vault:ReturnType<typeof useVault>,photo:PhotoRow,grant:PhotoGrant,checkCurrent:()=>void=()=>{},keepNavigation=false):Promise<PreparedPhotoRefresh>{
 checkCurrent();
 const {content,payload}=await diagnosticStep('photo.decrypt',()=>readPhoto(vault,photo,[grant]));checkCurrent();
 const media={...content.media![0],id:crypto.randomUUID()},context={...grant.envelope.context,createdAt:new Date().toISOString()};
 const {photoDate:_,...mediaContext}=context;
 const encrypted=await diagnosticStep('photo.encrypt_media',()=>vault.sealPhotoRefresh({...payload,...media},{...mediaContext,id:media.id,kind:"media"},grant.id));checkCurrent();
 const bytes=new TextEncoder().encode(JSON.stringify(encrypted));
 if(bytes.length>22_020_096)throw Error("This encrypted photo is too large for this album's audience.");
 try{
  await diagnosticStep('photo.upload_media',()=>uploadPhotoMedia(encrypted,media.videoVersion===3?payload.video:undefined,grant.id,keepNavigation));checkCurrent();
  const envelope=await diagnosticStep('photo.encrypt_metadata',()=>vault.sealPhotoRefresh({...content,media:[media]},context,grant.id));checkCurrent();
  return {id:photo.id,photoId:photo.id,source:grant.envelope,body:{envelope,media_id:media.id,expected_media_id:grant.media_id,expected_revision:photo.revision}};
 }catch(error){
  // No grant submission yet. Only this preparer's unattached ID is disposable.
  try{checkCurrent();await request(`/media/${media.id}`,{method:"DELETE",backgroundSave:keepNavigation,keepNavigation});}catch{}
  throw error;
 }
}
export async function submitPhotoRefresh(candidate:PreparedPhotoRefresh,keepNavigation=false){
 const path=`/photos/${candidate.photoId}/grants/${candidate.body.envelope.context.id}/refresh`;
 if(keepNavigation)await request(path,{method:"POST",backgroundSave:true,keepNavigation:true,body:JSON.stringify(candidate.body)});else await post(path,candidate.body);
}
export function photoRefreshOutcome(candidate:PreparedPhotoRefresh,latest:PhotoRow):"committed"|"unchanged"|"changed"{
 const grant=latest.grants.find(g=>g.id===candidate.body.envelope.context.id);
 if(grant?.media_id===candidate.body.media_id&&canonicalJson(grant.envelope)===canonicalJson(candidate.body.envelope))return "committed";
 if(latest.revision===candidate.body.expected_revision&&grant?.media_id===candidate.body.expected_media_id&&canonicalJson(grant.envelope)===canonicalJson(candidate.source))return "unchanged";
 return "changed";
}
export async function refreshPhotoGrant(vault:ReturnType<typeof useVault>,photo:PhotoRow,grant:PhotoGrant,checkCurrent:()=>void=()=>{},keepNavigation=false){
 const candidate=await preparePhotoRefresh(vault,photo,grant,checkCurrent,keepNavigation);checkCurrent();
 try{await submitPhotoRefresh(candidate,keepNavigation);}
 catch(error){
  checkCurrent();const latest=(await get("/photos/"+photo.id)).photo as PhotoRow;
  if(photoRefreshOutcome(candidate,latest)==="committed")return;
  throw error;
 }
}
export async function shareAlbumHistory(vault:ReturnType<typeof useVault>,albumId:string,onProgress:(done:number,failed:number)=>void){
 let after:string|null=null,done=0,failed=0;const seen=new Set<string>();
 do{
  const result:{items:PhotoRow[];next:string|null}=await get(`/photos?album=${albumId}${after?"&after="+encodeURIComponent(after):""}`);
  for(const photo of result.items as PhotoRow[]){
   if(seen.has(photo.id))continue;seen.add(photo.id);
   try{await refreshAlbumPhoto(vault,photo,albumId);done++;}catch{failed++;}
   onProgress(done,failed);
  }
  after=result.next;
 }while(after);
 return {done,failed};
}
