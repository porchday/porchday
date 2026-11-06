/** Video v2 keeps the manifest inside the existing signed OpenPGP envelope.
 * Only call validateVideoManifest after verifying that envelope. Segment bytes
 * use standard AES-256-GCM, with independent random 96-bit nonces. Never expose
 * the manifest's key/nonce metadata to server routing or telemetry. */
import {base64ToBytes,bytesToBase64} from './index.ts';
export const VIDEO_CHUNK_BYTES=4*1024*1024;
export const VIDEO_MAX_BYTES=250*1024*1024;
export const VIDEO_SOURCE_MAX_BYTES=1024*1024*1024;
export const VIDEO_MAX_SECONDS=600;
export const VIDEO_MAX_CHUNKS=Math.ceil(VIDEO_MAX_BYTES/VIDEO_CHUNK_BYTES);
export interface VideoSegment {index:number;size:number;sha256:string;nonce:string}
export interface VideoManifest {
 v:2;protocol:'porchday-video-aes256gcm-v2';streamId:string;key:string;
 mime:'video/mp4';size:number;duration:number;width:number;height:number;
 chunkSize:typeof VIDEO_CHUNK_BYTES;segments:VideoSegment[];
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder=new TextEncoder();
function fail():never{throw Error('Invalid encrypted video manifest');}
function exactKeys(value:object,keys:string[]){if(Object.keys(value).sort().join('|')!==keys.sort().join('|'))fail();}
function fixedBase64(value:unknown,size:number){if(typeof value!=='string')return fail();let bytes:Uint8Array;try{bytes=base64ToBytes(value);}catch{return fail();}if(bytes.length!==size||bytesToBase64(bytes)!==value)fail();return bytes;}
export function validateVideoManifest(value:unknown):VideoManifest {
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 const m=value as VideoManifest;
 exactKeys(m,['v','protocol','streamId','key','mime','size','duration','width','height','chunkSize','segments']);
 if(m.v!==2||m.protocol!=='porchday-video-aes256gcm-v2'||typeof m.streamId!=='string'||!uuid.test(m.streamId)||m.mime!=='video/mp4'||m.chunkSize!==VIDEO_CHUNK_BYTES)fail();
 fixedBase64(m.key,32);
 if(!Number.isSafeInteger(m.size)||m.size<1||m.size>VIDEO_MAX_BYTES||!Number.isFinite(m.duration)||m.duration<=0||m.duration>VIDEO_MAX_SECONDS)fail();
 if(!Number.isSafeInteger(m.width)||!Number.isSafeInteger(m.height)||m.width<1||m.height<1||Math.max(m.width,m.height)>1920||Math.min(m.width,m.height)>1080)fail();
 if(!Array.isArray(m.segments)||m.segments.length!==Math.ceil(m.size/VIDEO_CHUNK_BYTES)||m.segments.length>VIDEO_MAX_CHUNKS)fail();
 const nonces=new Set<string>();
 for(let index=0;index<m.segments.length;index++){
  const s=m.segments[index];if(!s||typeof s!=='object'||Array.isArray(s))fail();exactKeys(s,['index','size','sha256','nonce']);
  if(s.index!==index||s.size!==Math.min(VIDEO_CHUNK_BYTES,m.size-index*VIDEO_CHUNK_BYTES)+16||typeof s.sha256!=='string'||!/^[a-f0-9]{64}$/.test(s.sha256))fail();
  fixedBase64(s.nonce,12);if(nonces.has(s.nonce))fail();nonces.add(s.nonce);
 }
 return m;
}
export function videoAdditionalData(streamId:string,index:number,size:number):Uint8Array {
 if(!uuid.test(streamId)||!Number.isSafeInteger(index)||index<0||index>=VIDEO_MAX_CHUNKS||!Number.isSafeInteger(size)||size<1||size>VIDEO_CHUNK_BYTES)fail();
 // Fixed ASCII grammar, identical in WebCrypto and CryptoKit. Size is plaintext.
 return encoder.encode(`porchday-video-v2\n${streamId}\n${index}\n${size}`);
}
export async function videoHash(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function createVideoKey(){return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));}
export async function encryptVideoSegment(key:string,streamId:string,index:number,plaintext:Uint8Array):Promise<{bytes:Uint8Array;segment:VideoSegment}>{
 const aad=videoAdditionalData(streamId,index,plaintext.length),nonce=crypto.getRandomValues(new Uint8Array(12));
 const cryptoKey=await crypto.subtle.importKey('raw',new Uint8Array(fixedBase64(key,32)),'AES-GCM',false,['encrypt']);
 const bytes=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new Uint8Array(aad),tagLength:128},cryptoKey,new Uint8Array(plaintext)));
 return {bytes,segment:{index,size:bytes.length,sha256:await videoHash(bytes),nonce:bytesToBase64(nonce)}};
}
export async function decryptVideoSegment(manifest:VideoManifest,index:number,ciphertext:Uint8Array):Promise<Uint8Array>{
 const m=validateVideoManifest(manifest),s=m.segments[index];
 if(!Number.isSafeInteger(index)||!s||ciphertext.length!==s.size||await videoHash(ciphertext)!==s.sha256)throw Error('Video segment integrity check failed');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(fixedBase64(m.key,32)),'AES-GCM',false,['decrypt']);
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(fixedBase64(s.nonce,12)),additionalData:new Uint8Array(videoAdditionalData(m.streamId,index,s.size-16)),tagLength:128},key,new Uint8Array(ciphertext)));
}
/** Inclusive single byte range; multi-range and unsatisfiable ranges are rejected. */
export function videoByteRange(header:string|null,size:number):{start:number;end:number;partial:boolean}|null{
 if(!Number.isSafeInteger(size)||size<1||size>VIDEO_MAX_BYTES)return null;
 if(header===null)return{start:0,end:size-1,partial:false};
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))return null;
 let start:number,end:number;
 if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return null;end=Math.min(end,size-1);}
 return{start,end,partial:true};
}
