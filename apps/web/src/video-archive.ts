import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {decryptVideoSegment,validateVideoManifest,VIDEO_CHUNK_BYTES,VIDEO_MAX_BYTES,type VideoManifest} from '@porchday/crypto/video';
import type {Json} from './api';
export const archiveVideoPath=(id:string,index:number)=>`videos/${id}/${index}.part`;
const uuid=/^[a-f0-9-]{36}$/;
export function validateArchivedVideo(record:Json){
 if(record.videoVersion!==2||!uuid.test(record.id)||record.mime!=='video/mp4'||record.path!==`photos/${record.id}.mp4`||!Number.isSafeInteger(record.size)||record.size<1||record.size>VIDEO_MAX_BYTES||!Number.isFinite(record.duration)||record.duration<=0||record.duration>600||!Number.isSafeInteger(record.width)||!Number.isSafeInteger(record.height)||Math.min(record.width,record.height)<1||Math.max(record.width,record.height)>1920||Math.min(record.width,record.height)>1080||!Array.isArray(record.segments)||record.segments.length!==Math.ceil(record.size/VIDEO_CHUNK_BYTES)||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error('An archived video has invalid metadata.');
 for(let index=0;index<record.segments.length;index++){const s=record.segments[index];if(s.id!==record.id||s.index!==index||s.path!==archiveVideoPath(record.id,index)||s.size!==Math.min(VIDEO_CHUNK_BYTES,record.size-index*VIDEO_CHUNK_BYTES)||!/^[a-f0-9]{64}$/.test(s.sha256))throw Error('An archived video has invalid segments.');}
}
export function validateArchivedSegment(record:Json,files:Record<string,Uint8Array>){if(!uuid.test(record.id)||!Number.isSafeInteger(record.index)||record.index<0||record.index>62||record.path!==archiveVideoPath(record.id,record.index)||!Number.isSafeInteger(record.size)||record.size<1||record.size>VIDEO_CHUNK_BYTES||!files[record.path]||files[record.path].length!==record.size||bytesToHex(sha256(files[record.path]))!==record.sha256)throw Error('An archived video segment is missing or damaged.');}
export async function exportVideoSegments(id:string,value:unknown,read:(index:number,size:number)=>Promise<Uint8Array>,append:(record:Json,bytes:Uint8Array)=>Promise<void>){
 const manifest=validateVideoManifest(value),hash=sha256.create(),segments:Json[]=[];
 for(const segment of manifest.segments){const bytes=await decryptVideoSegment(manifest,segment.index,await read(segment.index,segment.size));hash.update(bytes);const record={id,index:segment.index,path:archiveVideoPath(id,segment.index),size:bytes.length,sha256:bytesToHex(sha256(bytes))};await append(record,bytes);segments.push(record);}
 return{videoVersion:2,size:manifest.size,duration:manifest.duration,width:manifest.width,height:manifest.height,segments,sha256:bytesToHex(hash.digest())};
}
export async function boundedVideoResponse(response:Response,size:number){if(!response.ok||!response.body)throw Error('This video changed or is no longer available.');const bytes=new Uint8Array(size),reader=response.body.getReader();let count=0;try{for(;;){const chunk=await reader.read();if(chunk.done)break;if(count+chunk.value.length>size)throw Error('Oversized video segment');bytes.set(chunk.value,count);count+=chunk.value.length;}if(count!==size)throw Error('Incomplete video segment');return bytes;}finally{await reader.cancel().catch(()=>{});}}
export async function assembleArchivedVideo(record:Json,read:(segment:Json)=>Promise<Uint8Array>){
 validateArchivedVideo(record);const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('porchday-video-preparation',{create:true}),id=crypto.randomUUID(),handle=await dir.getFileHandle(id,{create:true}),writer=await handle.createWritable(),hash=sha256.create();
 try{for(const segment of record.segments){const bytes=await read(segment);validateArchivedSegment(segment,{[segment.path]:bytes});hash.update(bytes);await writer.write(new Uint8Array(bytes));}if(bytesToHex(hash.digest())!==record.sha256)throw Error('The archived video checksum does not match.');await writer.close();const blob=await handle.getFile();return{blob,async dispose(){await dir.removeEntry(id).catch(()=>{});}};}catch(error){await writer.abort().catch(()=>{});await dir.removeEntry(id).catch(()=>{});throw error;}
}
