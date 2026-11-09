import {fingerprint} from "@porchday/crypto";
import {openPreview} from '../../../packages/crypto/src/notification-preview';
import {storedPreviewKeys} from './notification-preview-store';
async function contentPreview(reference:unknown){
 try{const ref=reference as {token?:string;keyId?:string};if(!/^[a-f0-9]{64}$/.test(ref?.token||'')||!ref.keyId)return null;const stored=(await storedPreviewKeys()).find(k=>k.identity.keyId===ref.keyId);if(!stored)return null;
 const response=await fetch('/api/notification-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ref.token}),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(7000)});if(!response.ok||!response.body)return null;
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1_000_000)throw Error('PREVIEW_TOO_LARGE');chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const data=JSON.parse(new TextDecoder().decode(bytes));
 if(data.identity.keyId!==stored.identity.keyId||data.identity.memberId!==stored.identity.memberId||data.identity.deviceId!==stored.identity.deviceId||data.author_key.member_id!==data.context.authorId||data.author_key.id!==data.context.authorDeviceId)return null;
 if(stored.pins?.[data.context.authorId+":"+data.context.authorDeviceId]!==await fingerprint(data.author_key.public_key))return null;
 const content=await openPreview(data.signed,data.context,stored.identity,stored.privateKey,data.author_key.public_key);
 if(!(await storedPreviewKeys()).some(k=>k.identity.keyId===ref.keyId))return null;
 return {...content,url:data.context.kind==='post'?'/post/'+data.context.id:'/?photo='+data.context.id};
 }catch{return null;}
}
Object.assign(self,{porchdayNotificationPreview:contentPreview});
