import {base64ToBytes} from "@porchday/crypto";
import {ApiError,get,type EncryptedEnvelope} from "./api";
import type {useVault} from "./vault";
import {publishPhoto} from "./photo-publish";
import {addPhotoToAlbum} from "./photo-album";
import {preservedPhotoDeadline} from "./archive";
import {verifyAttachmentDate} from "./attachment-photo-date";
import {validTags} from "./PeopleTags";
import {validatedMedia} from "./video";
export async function adoptAttachment(vault:ReturnType<typeof useVault>,postId:string,mediaId:string,day:string,albumId:string){
  let existing;
  try{existing=(await get("/photos/"+mediaId)).photo;}
  catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
  if(existing){
    if(existing.owner_id!==vault.member.id||existing.source_media_id!==mediaId||existing.source_post_id!==postId)throw Error("This photo identity has a different source.");
    await addPhotoToAlbum(vault,mediaId,albumId);return;
  }
  const {post:original}=await get("/posts/"+postId);
  if(original.author_id!==vault.member.id||!original.media.some((m:any)=>m.id===mediaId))throw Error("Only the owner can add an attached photo to an album.");
  const content=await vault.open(original),metadata=content.media?.find(m=>m.id===mediaId);
  if(!metadata)throw Error("This photo is not in the signed post.");
  const {date,photo_id}=await get(`/media/${mediaId}/photo-date`);
  if(photo_id){const {photo}=await get("/photos/"+photo_id);if(photo.owner_id!==vault.member.id||photo.source_media_id!==mediaId||photo.source_post_id!==postId)throw Error("This photo identity has a different source.");await addPhotoToAlbum(vault,photo_id,albumId);return;}
  if(date?.photo_date){await verifyAttachmentDate(vault,date,mediaId,postId,vault.member.id,date.photo_date);day=date.photo_date;}
  const envelope=await get<EncryptedEnvelope>(`/media/${mediaId}/bytes`);
  if(envelope.context.parentId!==postId||envelope.context.kind!=="media"||envelope.context.authorId!==vault.member.id)throw Error("This photo does not belong to the original post.");
  const payload=await vault.open({id:mediaId,envelope});
  if(typeof payload.bytes!=="string"||(payload.mime||"image/jpeg")!==(metadata.mime||"image/jpeg"))throw Error("Photo content does not match the signed post.");
  const bytes=base64ToBytes(payload.bytes),decoded=await validatedMedia(bytes,metadata.mime||"image/jpeg");
  const expiresAt=preservedPhotoDeadline(envelope.context.expiresAt,original.expires_at);
  await publishPhoto(vault,{id:mediaId,name:metadata.name||"photo.jpg",alt:metadata.alt||"",tags:validTags(metadata.tags),
    blob:new Blob([bytes as BlobPart],{type:metadata.mime||"image/jpeg"}),mime:metadata.mime||"image/jpeg",width:decoded.width,height:decoded.height,
    ...("poster" in decoded?{poster:decoded.poster}:{}),photoDate:day,source:{postId,revision:(date?.revision||0)+1}},"only_me",expiresAt,albumId);
}
