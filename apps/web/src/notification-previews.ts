import {signStatement,verifyStatement,type EncryptedEnvelope} from '@porchday/crypto';
import {notificationKey,sealPreview,type PreviewIdentity,type PreviewContext} from '../../../packages/crypto/src/notification-preview';
import {clearPreviewKeys,previewGeneration,savePreviewKey,storedPreviewKeys} from './notification-preview-store';
import {isNativeShell,nativeCall} from './native-shell';
import {del,post,request,type Device} from './api';
import {recordDiagnostic,safeDiagnosticError} from './diagnostics';
import type {useVault} from './vault';
type Vault=ReturnType<typeof useVault>;
const preference=(member:string)=>'porchday-notification-content:'+member;
export function contentPreviewsEnabled(member:string){return localStorage.getItem(preference(member))!=='off';}
export async function setContentPreviews(member:string,enabled:boolean){localStorage.setItem(preference(member),enabled?'on':'off');if(!enabled){await del('/notification-previews/keys');await clearPreviewKeys();if(isNativeShell())await nativeCall('clearPreviewKeys');}window.dispatchEvent(new Event('porchday:push-changed'));}
function trustedPreviewAuthors(){const pins:Record<string,string>={};for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i)||'';if(/^porchday-key:[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(name)){const value=localStorage.getItem(name)||'';if(/^[a-f0-9]{40,64}$/i.test(value))pins[name.slice('porchday-key:'.length)]=value;}}return pins;}
export type PreviewEnrollmentReceipt={key?:string;at?:number};
export async function enrollContentPreviews(vault:Vault,active:()=>boolean,receipt?:PreviewEnrollmentReceipt){
 if(!contentPreviewsEnabled(vault.member.id)||!active()){if(receipt){delete receipt.key;delete receipt.at;}return;}
 const native=isNativeShell(),stored=JSON.parse(localStorage.getItem(native?'porchday-native-push-subscription':'porchday-push-subscription')||'null');if(stored?.memberId!==vault.member.id||!stored.id)return;
 const generation=previewGeneration(),pins=trustedPreviewAuthors();let identity:PreviewIdentity;
 if(native){const result=await nativeCall('notificationPreviewKey',{memberId:vault.member.id,deviceId:vault.device.id,pins}) as {keyId:string;publicKey:string};identity={v:1,purpose:'porchday-notification-key',memberId:vault.member.id,deviceId:vault.device.id,keyId:result.keyId,publicKey:result.publicKey};}
 else{const row=(await storedPreviewKeys()).find(r=>r.identity.memberId===vault.member.id&&r.identity.deviceId===vault.device.id);if(row){identity=row.identity;await savePreviewKey({...row,pins},generation);}else{const key=await notificationKey();identity={v:1,purpose:'porchday-notification-key',memberId:vault.member.id,deviceId:vault.device.id,keyId:crypto.randomUUID(),publicKey:key.publicKey};if(!active())return;await savePreviewKey({identity,privateKey:key.privateKey,pins},generation);}}
 if(!active()||generation!==previewGeneration())return;
 // Keep local/native trust pins current each minute, but an acknowledged
 // unchanged registration needs only a bounded repair refresh. This receipt is
 // component/session memory, never an authorization or delivery cache.
 const enrollmentKey=JSON.stringify([identity,native,stored.id,generation]);
 if(receipt?.key===enrollmentKey&&receipt.at!==undefined&&Date.now()>=receipt.at&&Date.now()-receipt.at<15*60_000)return;
 const certificate=await signStatement(identity,vault.privateKey);if(!active()||generation!==previewGeneration()||!contentPreviewsEnabled(vault.member.id))return;
 await post('/notification-previews/keys',{certificate,native,subscription_id:stored.id});
 if(receipt&&active()&&generation===previewGeneration()&&contentPreviewsEnabled(vault.member.id)){receipt.key=enrollmentKey;receipt.at=Date.now();}
}
export async function previewThumbnail(photo?:{blob:Blob;mime?:string;poster?:string}):Promise<string|undefined>{
 if(!photo)return;const blob=photo.mime?.startsWith('video/')?(photo.poster?new Blob([Uint8Array.from(atob(photo.poster),c=>c.charCodeAt(0))],{type:"image/jpeg"}):null):photo.blob;if(!blob)return;
 const url=URL.createObjectURL(blob);try{const img=new Image();img.src=url;await Promise.race([img.decode(),new Promise((_,reject)=>setTimeout(()=>reject(Error('PREVIEW_DECODE_TIMEOUT')),3000))]);const scale=Math.min(1,160/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext('2d');if(!ctx)return;ctx.drawImage(img,0,0,canvas.width,canvas.height);const result=canvas.toDataURL('image/jpeg',0.55);return result.length<=24000?result:undefined;}finally{URL.revokeObjectURL(url);}
}
export async function prepareNotificationPreview(vault:Vault,envelopes:EncryptedEnvelope[],kind:'post'|'photo',id:string,text:string,photo?:{blob:Blob;mime?:string;poster?:string}){
 try{const source=envelopes[0].context,recipients=envelopes.flatMap(e=>e.recipients),result=await(await request('/notification-previews/recipients',{method:'POST',body:JSON.stringify({devices:[...new Set(recipients.map(r=>r.deviceId))]}),signal:AbortSignal.timeout(5000)})).json(),keys:PreviewIdentity[]=[];
 for(const row of result.items||[]){const device=row.author_key as Device;if(!recipients.some(r=>r.deviceId===device.id&&r.memberId===device.member_id&&r.fingerprint===device.fingerprint))continue;await vault.verifyDevice(device);const identity=await verifyStatement(row.certificate,device.public_key) as PreviewIdentity;if(identity.v!==1||identity.purpose!=='porchday-notification-key'||identity.memberId!==device.member_id||identity.deviceId!==device.id||identity.keyId!==row.id)continue;if(!keys.some(k=>k.keyId===identity.keyId))keys.push(identity);}
 if(!keys.length)return;
 const context:PreviewContext={v:1,purpose:'porchday-notification-preview',kind,id,authorId:source.authorId,authorDeviceId:source.authorDeviceId,revision:source.revision,expiresAt:source.expiresAt};const image=await previewThumbnail(photo).catch(()=>undefined);return await sealPreview(context,{text:[...text.trim().replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ')].slice(0,240).join(''),...(image?{image}:{})},keys,vault.privateKey);
 }catch(error){recordDiagnostic('operation',{operation:'notification_preview',stage:'prepare',outcome:'generic_fallback',error:safeDiagnosticError(error).error,code:safeDiagnosticError(error).code||"unknown"});return;}
}
