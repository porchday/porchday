import {get,post,type Device,type Member} from './api';
import {authorizeDevice,createRecoverySecret,generateDeviceKeys,signStatement,unlockPrivateKey,verifyStatement,type UnlockedPrivateKey} from '@porchday/crypto';
import {rememberDevice,recallDevice,forgetDevice} from '@porchday/crypto/browser';
import {deviceBackupBinding,importRecoveryPrivateKey,openRecoveryPayload,sealRecoveryPayload,recoveryDigest,type RecoveryBinding,type RecoveryBackup} from '@porchday/crypto/recovery';
export type RecoveryActor={member:Member;device:Device;privateKey:UnlockedPrivateKey;keys:UnlockedPrivateKey[]};
export type RecoveryState={enabled:boolean;required:boolean;check:{kit_checked_at:string|null;prompt_dismissed_at:string|null}|null;methods:any[];pairInvitations:any[];contacts:any[];invitations:any[];requests:any[];responses:any[];devices:Device[];handles:{id:string;handle:string}[]};
export type PendingRecovery={record:any;key:UnlockedPrivateKey};
const pendingSlot=(member:string)=>'porchday-pending-key-recovery:'+member;
export const recoveryExpiry=(ms=240000)=>new Date(Date.now()+ms).toISOString();
export const recoveryIdentity=(actor:RecoveryActor)=>({v:1 as const,memberId:actor.member.id,deviceId:actor.device.id,expiresAt:recoveryExpiry()});
export async function recoveryAction(actor:RecoveryActor,action:'remove'|'accept'|'decline'|'kit-checked'|'dismiss'|'complete',id:string,recoveryFingerprint?:string){
 return post('/key-recovery/actions',await signStatement({...recoveryIdentity(actor),purpose:'porchday-recovery-action',operationId:crypto.randomUUID(),action,id,...(recoveryFingerprint?{recoveryFingerprint}:{})},actor.privateKey));
}
export async function recoveryState():Promise<RecoveryState>{const value=await get('/key-recovery');if(!Array.isArray(value.methods)||!Array.isArray(value.requests)||!Array.isArray(value.contacts)||!Array.isArray(value.devices))throw Error('Recovery options are unavailable here.');return value as unknown as RecoveryState;}
export async function checkedMethod(method:any,memberId:string){
 const s=method?.record?.statement;if(!s||s.purpose!=='porchday-recovery-method'||s.memberId!==memberId||s.id!==method.id||method.owner_id!==memberId||method.disabled_at)throw Error('Recovery method is unavailable.');
 const author=await get('/devices/'+s.deviceId);if(author.member_id!==memberId)throw Error('Recovery author mismatch.');await verifyStatement(method.record,author.public_key);return s;
}
export function shareBinding(memberId:string,methodId:string,recipientFingerprint:string,requestId=''):RecoveryBinding{return{v:1,purpose:requestId?'porchday-recovery-response':'porchday-recovery-share',memberId,methodId,requestId,recipientFingerprint};}
export async function readContactShare(actor:RecoveryActor,method:any){
 const s=await checkedMethod(method,method.owner_id),contact=s.contacts?.find((v:any)=>v.memberId===actor.member.id);
 const recipient=contact?[actor.privateKey,...actor.keys].find(key=>key.getFingerprint()===contact.fingerprint):undefined;
 if(!contact||!recipient)throw Error('This device does not have the key for your recovery share. Restore your own key history or use another trusted device.');
 const author=await get('/devices/'+s.deviceId);
 const payload=await openRecoveryPayload<{share:string}>(contact.ciphertext,shareBinding(s.memberId,s.id,contact.fingerprint),recipient,author.public_key);
 if(await recoveryDigest(payload.share)!==contact.shareHash)throw Error('Recovery share verification failed.');return{share:payload.share,method:s,contact};
}
export async function startRecoveryRequest(member:Member,kind:'pair'|'contacts',methodId:string|null,label:string,invitationId?:string):Promise<PendingRecovery>{
 const id=crypto.randomUUID(),deviceId=crypto.randomUUID(),secret=createRecoverySecret(),keys=await generateDeviceKeys(member.id,deviceId,secret);
 const key=await unlockPrivateKey(keys.encryptedPrivateKey,secret,keys.fingerprint);
 const statement={v:1,purpose:'porchday-recovery-request',id,memberId:member.id,kind,methodId,...(invitationId?{invitationId}:{}),deviceId,publicKey:keys.publicKey,fingerprint:keys.fingerprint,label:label.trim()||'New device',expiresAt:recoveryExpiry(kind==='pair'?9*60000:23*3600000)};
 const record=await signStatement(statement,key);
 // Ordinary temporary device keys only, protected with the existing IndexedDB key vault.
 await rememberDevice({memberId:member.id,deviceId,fingerprint:keys.fingerprint},key);
 localStorage.setItem(pendingSlot(member.id),JSON.stringify(record));
 await post('/key-recovery/requests',record);return{record,key};
}
export async function restorePendingRecovery(memberId:string):Promise<PendingRecovery|null>{
 const value=localStorage.getItem(pendingSlot(memberId));if(!value)return null;
 try{const record=JSON.parse(value),s=record.statement;if(s.memberId!==memberId||Date.parse(s.expiresAt)<=Date.now()){localStorage.removeItem(pendingSlot(memberId));await forgetDevice({memberId,deviceId:s.deviceId,fingerprint:s.fingerprint});return null;}
 const key=await recallDevice({memberId,deviceId:s.deviceId,fingerprint:s.fingerprint});if(!key)return null;await verifyStatement(record,s.publicKey);return{record,key};}catch{return null;}
}
export async function finishRecoveryRequest(pending:PendingRecovery,cancel:boolean){
 const s=pending.record.statement;await post('/key-recovery/requests/'+s.id+'/finish',{cancel,proof:await signStatement({v:1,purpose:'porchday-recovery-finish',requestId:s.id,memberId:s.memberId,cancel},pending.key)});localStorage.removeItem(pendingSlot(s.memberId));if(cancel)await forgetDevice({memberId:s.memberId,deviceId:s.deviceId,fingerprint:s.fingerprint});
}
export function pairingCode(record:any){const s=record.statement;return 'porchday-pair:1:'+s.id+':'+s.fingerprint;}
export function parsePairingCode(value:string){
 let code=value.trim();if(code.startsWith('https://')){const u=new URL(code);if(u.origin!==location.origin)throw Error('Use a pairing code from this Porchday site.');code=decodeURIComponent(u.hash.replace(/^#pair=/,''));}
 const match=/^porchday-pair:1:([0-9a-f-]{36}):([0-9a-f]{64})$/.exec(code);if(!match)throw Error('That is not a Porchday pairing code.');return{id:match[1],fingerprint:match[2]};
}
export async function approvePairing(actor:RecoveryActor,request:any,code:string){
 const expected=parsePairingCode(code),s=request.record.statement;
 if(request.kind!=='pair'||request.state!=='pending'||s.id!==expected.id||s.fingerprint!==expected.fingerprint||s.memberId!==actor.member.id||Date.parse(s.expiresAt)<=Date.now())throw Error('Pairing code expired or does not match this account.');
 await verifyStatement(request.record,s.publicKey);
 const {envelope:backup}=await get('/keys/backup') as {envelope:RecoveryBackup};
 const keys=[actor.privateKey,...actor.keys],entries=backup.devices.flatMap(device=>{const key=keys.find(k=>k.getFingerprint()===device.fingerprint);return key?[{device,armor:key.armor()}]:[];});
 if(!entries.some(e=>e.device.fingerprint===actor.device.fingerprint))throw Error('This device key is missing from your backup. Check recovery before pairing.');
 const challenge=await post('/devices/challenge',{id:s.deviceId,public_key:s.publicKey,fingerprint:s.fingerprint});
 const authorization=await authorizeDevice({v:1,purpose:'porchday-device-authorization',memberId:s.memberId,authorizingDeviceId:actor.device.id,deviceId:s.deviceId,fingerprint:s.fingerprint,challenge:challenge.challenge,expiresAt:challenge.expires_at},actor.privateKey);
 const binding:RecoveryBinding={v:1,purpose:'porchday-device-transfer',memberId:s.memberId,methodId:s.id,requestId:s.id,recipientFingerprint:s.fingerprint};
 const ciphertext=await sealRecoveryPayload(binding,{entries},s.publicKey,actor.privateKey);
 await post('/key-recovery/pair-approval',await signStatement({...recoveryIdentity(actor),purpose:'porchday-pair-approval',requestId:s.id,requestFingerprint:s.fingerprint,ciphertext,authorization},actor.privateKey));
}
export async function receivePairing(pending:PendingRecovery,request:any){
 const s=pending.record.statement,a=request.approval?.statement;
 if(!a||request.state!=='approved'||request.owner_id!==s.memberId||a.memberId!==s.memberId||a.requestId!==s.id||a.requestFingerprint!==s.fingerprint||Date.parse(s.expiresAt)<=Date.now())throw Error('Pairing approval unavailable.');
 const author=await get('/devices/'+a.deviceId);if(author.member_id!==s.memberId||author.revoked_at)throw Error('The approving device is no longer trusted.');await verifyStatement(request.approval,author.public_key);
 const binding:RecoveryBinding={v:1,purpose:'porchday-device-transfer',memberId:s.memberId,methodId:s.id,requestId:s.id,recipientFingerprint:s.fingerprint};
 const payload=await openRecoveryPayload<{entries:{device:RecoveryBackup['devices'][number];armor:string}[]}>(a.ciphertext,binding,pending.key,author.public_key);
 const {envelope:backup}=await get('/keys/backup') as {envelope:RecoveryBackup};
 if(!payload.entries.length||payload.entries.length>backup.devices.length||new Set(payload.entries.map(e=>e.device.id)).size!==payload.entries.length||!payload.entries.some(e=>e.device.fingerprint===author.fingerprint))throw Error('Transferred history does not match the approving device.');
 const history:UnlockedPrivateKey[]=[];
 for(const entry of payload.entries){const saved=backup.devices.find(d=>d.id===entry.device.id&&d.fingerprint===entry.device.fingerprint&&d.public_key===entry.device.public_key);if(!saved)throw Error('History key mismatch.');history.push(await importRecoveryPrivateKey(entry.armor,saved.fingerprint));}
 const device={id:s.deviceId,member_id:s.memberId,public_key:s.publicKey,fingerprint:s.fingerprint,name:s.label};
 const recovery_ciphertext=await sealRecoveryPayload(deviceBackupBinding(s.memberId,device,backup.recovery.fingerprint),pending.key.armor(),backup.recovery.public_key,pending.key);
 const existing=backup.devices.find(d=>d.id===device.id);
 if(existing){const enrolled=await get('/devices/'+device.id);if(enrolled.revoked_at||enrolled.member_id!==s.memberId||enrolled.fingerprint!==s.fingerprint||existing.public_key!==s.publicKey)throw Error('Paired device identity changed.');}
 else await post('/devices',{...device,authorization:{type:'trusted',signed:a.authorization},backup:{...backup,devices:[...backup.devices,{id:device.id,public_key:device.public_key,fingerprint:device.fingerprint,recovery_ciphertext}]}});
 for(const key of history){const old=backup.devices.find(d=>d.fingerprint===key.getFingerprint())!;await rememberDevice({memberId:s.memberId,deviceId:old.id,fingerprint:old.fingerprint},key);}
 // Persist the active-device pointer before clearing the resumable request.
 localStorage.setItem('porchday-device:'+s.memberId,device.id);
 await finishRecoveryRequest(pending,false);return{device,key:pending.key,history};
}

export async function createPairingInvitation(actor:RecoveryActor){
 const record=await signStatement({...recoveryIdentity(actor),purpose:'porchday-pair-invitation',id:crypto.randomUUID(),fingerprint:actor.device.fingerprint},actor.privateKey);
 await post('/key-recovery/pair-invitations',record);return record;
}
export function invitationCode(record:any){return 'porchday-invite:1:'+record.statement.id+':'+record.statement.fingerprint;}
export async function checkPairingInvitation(memberId:string,code:string){
 const match=/^porchday-invite:1:([0-9a-f-]{36}):([0-9a-f]{64})$/.exec(code.trim());if(!match)throw Error('That is not a trusted-device invitation code.');
 const state=await recoveryState(),invitation=state.pairInvitations.find(r=>r.id===match[1]&&!r.request_id);
 const s=invitation?.record?.statement;if(!s||s.memberId!==memberId||s.fingerprint!==match[2]||Date.parse(s.expiresAt)<=Date.now())throw Error('Invitation expired or belongs to another account.');
 const device=state.devices.find(d=>d.id===s.deviceId&&!d.revoked_at&&d.fingerprint===s.fingerprint);if(!device)throw Error('The inviting device is no longer trusted.');await verifyStatement(invitation.record,device.public_key);return s.id;
}
export async function discardExpiredRecovery(pending:PendingRecovery){const s=pending.record.statement;localStorage.removeItem(pendingSlot(s.memberId));await forgetDevice({memberId:s.memberId,deviceId:s.deviceId,fingerprint:s.fingerprint});}
