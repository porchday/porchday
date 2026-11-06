/** Durable retry state contains ciphertext and public routing only. Plaintext
 * preparation and video keys must never be written into this directory. */
import {encryptVideoSegment,createVideoKey,VIDEO_CHUNK_BYTES,validateVideoManifest,type VideoManifest} from '@porchday/crypto/video';
import type {EncryptedEnvelope} from '@porchday/crypto';
import {get,post,request,del,type Json} from './api';
import type {PreparedLargeVideo} from './video-prepare';
type Reservation={id:string;envelope:EncryptedEnvelope;byte_size:number;stream_id?:string;segments?:{index:number;size:number;sha256:string}[]};
type Publication={version:1;owner:string;id:string;createdAt:string;media:Reservation[];post:Json};
const uuid=/^[a-f0-9-]{36}$/;
async function root(owner:string){if(!uuid.test(owner))throw Error('Invalid account');const root=await navigator.storage.getDirectory();return(await root.getDirectoryHandle('porchday-encrypted-video-outbox',{create:true})).getDirectoryHandle(owner,{create:true});}
async function directory(owner:string,id:string){if(!uuid.test(id))throw Error('Invalid upload');return(await root(owner)).getDirectoryHandle(id,{create:true});}
async function write(dir:FileSystemDirectoryHandle,name:string,data:Blob|string){const handle=await dir.getFileHandle(name,{create:true}),stream=await handle.createWritable();try{await stream.write(data);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}}
export async function discardLocalPublication(owner:string,id:string){await(await root(owner)).removeEntry(id,{recursive:true}).catch(()=>{});}
export async function stageVideo(owner:string,postId:string,mediaId:string,video:PreparedLargeVideo,signal:AbortSignal,progress?:(value:number)=>void){
 const dir=await directory(owner,postId),manifest:VideoManifest={v:2,protocol:'porchday-video-aes256gcm-v2',streamId:crypto.randomUUID(),key:createVideoKey(),mime:'video/mp4',size:video.blob.size,duration:video.duration,width:video.width,height:video.height,chunkSize:VIDEO_CHUNK_BYTES,segments:[]};
 for(let offset=0,index=0;offset<video.blob.size;offset+=VIDEO_CHUNK_BYTES,index++){
  signal.throwIfAborted();const encrypted=await encryptVideoSegment(manifest.key,manifest.streamId,index,new Uint8Array(await video.blob.slice(offset,offset+VIDEO_CHUNK_BYTES).arrayBuffer()));
  await write(dir,`${mediaId}-${index}`,new Blob([new Uint8Array(encrypted.bytes)]));manifest.segments.push(encrypted.segment);progress?.(Math.min(1,(offset+VIDEO_CHUNK_BYTES)/video.blob.size));
 }
 return validateVideoManifest(manifest);
}
export async function stageMedia(owner:string,postId:string,envelope:EncryptedEnvelope,video?:VideoManifest):Promise<Reservation>{
 const bytes=JSON.stringify(envelope),dir=await directory(owner,postId),id=envelope.context.id;
 await write(dir,id,bytes);
 return{id,envelope,byte_size:new TextEncoder().encode(bytes).length,...(video?{stream_id:video.streamId,segments:video.segments.map(({index,size,sha256})=>({index,size,sha256}))}:{})};
}
export async function savePublication(owner:string,id:string,media:Reservation[],body:Json){
 const publication:Publication={version:1,owner,id,createdAt:new Date().toISOString(),media,post:body};
 // Written last. An interrupted encryption has no publishable operation.
 await write(await directory(owner,id),'publication.json',JSON.stringify(publication));
}
async function readPublication(owner:string,id:string):Promise<Publication>{const file=await(await directory(owner,id)).getFileHandle('publication.json');const p=JSON.parse(await(await file.getFile()).text());if(p.version!==1||p.owner!==owner||p.id!==id||!Array.isArray(p.media)||p.media.length>10||p.post?.envelope?.context?.id!==id)throw Error('This saved upload is invalid. Cancel it and select your files again.');return p;}
export async function pendingPublications(owner:string){const found:{id:string;createdAt:string}[]=[],dir=await root(owner);for await(const[name,entry]of (dir as any).entries()){if(entry.kind!=='directory'||!uuid.test(name))continue;try{const p=await readPublication(owner,name);found.push({id:name,createdAt:p.createdAt});}catch{/* Incomplete local encryption is never publishable. */}}return found.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));}
export async function sendPublication(owner:string,id:string,signal:AbortSignal,progress?:(text:string)=>void){
 const publication=await readPublication(owner,id),dir=await directory(owner,id);
 for(const media of publication.media){
  signal.throwIfAborted();progress?.('Resuming encrypted upload…');
  const reservation=await request(media.stream_id?'/videos':'/media',{method:'POST',body:JSON.stringify(media),signal});
  if(media.stream_id){
   const state=await request(`/videos/${media.id}/status`,{signal});
   for(const segment of media.segments!){if(state.received.includes(segment.index))continue;signal.throwIfAborted();progress?.(`Uploading video segment ${segment.index+1} of ${media.segments!.length}…`);const file=await(await dir.getFileHandle(`${media.id}-${segment.index}`)).getFile();if(file.size!==segment.size)throw Error('Saved video data is incomplete. Cancel this upload and select the video again.');await request(`/videos/${media.id}/chunks/${segment.index}`,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream'},signal});}
   await request(`/videos/${media.id}/complete`,{method:'POST',body:'{}',signal});
  }
  if(reservation.state!=='attached'&&reservation.state!=='ready'){const file=await(await dir.getFileHandle(media.id)).getFile();await request(reservation.upload_url,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream'},signal});}
 }
 progress?.('Sharing post…');await request('/posts',{method:'POST',body:JSON.stringify(publication.post),signal});await discardLocalPublication(owner,id);
}
export async function cancelPublication(owner:string,id:string){
 const publication=await readPublication(owner,id);
 // An uncertain final POST may already have succeeded. Never delete published
 // media: the API refuses attached roots, and a confirmed post only clears local.
 try{await get('/posts/'+id);await discardLocalPublication(owner,id);return;}catch(error){if((error as {status?:number}).status!==404)throw error;}
 for(const media of publication.media)if(media.stream_id)await del('/videos/'+media.id);
 await discardLocalPublication(owner,id);
}
