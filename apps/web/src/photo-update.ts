import {createPhotoProof,photoMetadata,type PhotoProof} from "@porchday/crypto/photos";
import {ApiError,get,request,type MediaPayload} from "./api";
import {openPhoto,type PhotoRow} from "./photo-record";
import {signAttachmentDate} from "./attachment-photo-date";
import type {useVault} from "./vault";
export async function updatePhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,date:string,change?:(media:MediaPayload)=>MediaPayload){
 const envelopes=[];
 for(const grant of photo.grants){
  const decoded=await openPhoto(vault,photo,grant),media=decoded.media!.map(m=>change?change(m):m);
  const photoProof=await createPhotoProof({photoId:photo.id,ownerId:photo.owner_id,deviceId:vault.device.id,revision:photo.revision+1,date,
   expiresAt:photo.expires_at?new Date(photo.expires_at).toISOString():null,sha256:(decoded.photoProof as PhotoProof).statement.sha256,metadata:photoMetadata(media[0])},vault.privateKey);
  envelopes.push(await vault.sealPhotoUpdate({...decoded,media,photoProof},{...grant.envelope.context,photoDate:date,revision:photo.revision+1}));
 }
 let source_date;
 if(photo.source_media_id&&photo.source_post_id){
  try{
   const {date:current}=await get(`/media/${photo.source_media_id}/photo-date`);
   source_date=await signAttachmentDate(vault,photo.source_media_id,photo.source_post_id,date,(current?.revision||0)+1);
  }catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
 }
 await request("/photos/"+photo.id,{method:"PUT",body:JSON.stringify({photo_date:date,expected_revision:photo.revision,envelopes,...(source_date?{source_date}:{})})});
}
