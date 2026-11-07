import {canonicalJson,type EncryptedEnvelope,type Audience} from '@porchday/crypto';
import {createPhotoProof,photoMetadata,photoBytesHash,verifyPhotoBytes,type PhotoProof} from '@porchday/crypto/photos';
import {validateVideoManifest,type VideoManifest} from '@porchday/crypto/video';
import type {useVault} from './vault';
import {post,request,type MediaPayload} from './api';
import type {PreparedLargeVideo} from './video-prepare';
import {stageVideo,stageMedia,savePublication,discardLocalPublication,hasSavedPublication} from './video-outbox';
import {videoUpdatePlaceholder} from './video-placeholder';
import type {PhotoDraft} from './photo-publish';

export function photoVideoBytes(video:unknown){return new TextEncoder().encode(canonicalJson(validateVideoManifest(video)));}
export async function verifyPhotoVideo(proof:PhotoProof,video:unknown){await verifyPhotoBytes(proof,photoVideoBytes(video));return validateVideoManifest(video);}
/** Rewrap a complete stream without copying its ciphertext or weakening the source proof. */
export async function uploadPhotoMedia(envelope:EncryptedEnvelope,video?:unknown,photoRefreshId?:string){
 const manifest=video?validateVideoManifest(video):undefined;
 const bytes=new TextEncoder().encode(JSON.stringify(envelope));
 if(bytes.length>(manifest?1024*1024:22_020_096))throw Error('This encrypted attachment is too large for this audience.');
 const upload=await post(manifest?'/videos':'/media',{id:envelope.context.id,envelope,byte_size:bytes.length,...(manifest?{stream_id:manifest.streamId}:{}),...(photoRefreshId?{photo_refresh_id:photoRefreshId}:{})});
 await request(upload.upload_url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:new Blob([bytes])});
}
export async function stagePhotoVideo(vault:ReturnType<typeof useVault>,photo:PhotoDraft,prepared:PreparedLargeVideo,audience:Audience,expiresAt:string|null,album:string|null,signal:AbortSignal,progress?:(text:string)=>void){
 if(await hasSavedPublication(vault.member.id,photo.id))throw Error('This video has a saved encrypted upload. Resume or cancel it before sharing it again.');
 let saved=false;
 try{
  const createdAt=new Date().toISOString(),mediaId=crypto.randomUUID();
  const video:VideoManifest=await stageVideo(vault.member.id,photo.id,mediaId,prepared,signal,fraction=>progress?.(`Encrypting video… ${Math.round(fraction*100)}%`));
  const sha256=await photoBytesHash(photoVideoBytes(video)),grants=[],reservations=[];
  const destinations=[{audience,groupId:null as string|null},...(album?[{audience:'album' as Audience,groupId:album}]:[])];
  for(const [index,destination] of destinations.entries()){
   signal.throwIfAborted();
   const media:MediaPayload={id:index?crypto.randomUUID():mediaId,name:photo.name,alt:photo.alt,width:prepared.width,height:prepared.height,mime:'video/mp4',videoVersion:3,duration:prepared.duration,...(photo.archiveSha256?{archiveSha256:photo.archiveSha256}:{}),tags:photo.tags||[],...(photo.poster?{poster:photo.poster,posterExpiresAt:expiresAt}:{})};
   const common={...destination,parentId:photo.id,createdAt,expiresAt};
   const encrypted=await vault.seal({...media,video,bytes:videoUpdatePlaceholder},{...common,id:media.id,kind:'media'});
   reservations.push(await stageMedia(vault.member.id,photo.id,encrypted,video));
   const photoProof=await createPhotoProof({photoId:photo.id,ownerId:vault.member.id,deviceId:vault.device.id,revision:1,date:photo.photoDate!,expiresAt,sha256,metadata:photoMetadata(media)},vault.privateKey);
   const envelope=await vault.seal({media:[media],photoProof},{...common,id:crypto.randomUUID(),kind:'photo',photoDate:photo.photoDate});
   grants.push({envelope,media_id:media.id});
  }
  signal.throwIfAborted();
  await savePublication(vault.member.id,photo.id,reservations,{id:photo.id,photo_date:photo.photoDate,expires_at:expiresAt,grants},'photo');saved=true;
 }finally{if(!saved)await discardLocalPublication(vault.member.id,photo.id);}
}
