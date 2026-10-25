import type {EncryptedEnvelope} from '@porchday/crypto';
import {check} from './hosted-smoke-support.js';
import type {ArchiveBoundary} from './hosted-browser-archive-support.js';

/** Profile replacement is permitted only in the fresh destination, never in the source. */
export function captureDestinationProfile(body:any,b:ArchiveBoundary,previous:EncryptedEnvelope){
 const e=body?.profile?.envelope as EncryptedEnvelope,c=e?.context;
 check(body&&Object.keys(body).sort().join(',')==='id,posts,profile'&&/^[a-f0-9-]{36}$/i.test(body.id)&&
  Array.isArray(body.posts)&&body.posts.length===0&&Object.keys(body.profile).join(',')==='envelope'&&
  e?.v===1&&e.protocol==='porchday-openpgp-v1'&&typeof e.ciphertext==='string'&&c?.kind==='profile'&&c.id===b.member&&
  c.authorId===b.member&&c.authorDeviceId===b.device&&c.audience==='only_me'&&c.parentId===null&&c.groupId===null&&
  c.expiresAt===null&&c.createdAt===previous.context.createdAt&&c.revision===previous.context.revision+1&&
  e.recipients.length>0&&e.recipients.length<=8&&e.recipients.every(r=>r.memberId===b.member),'DESTINATION_PROFILE_BOUNDARY');
 return e;
}
export function assertDistinctDestination(source:{id:string;device:{keys:{fingerprint:string}}},destination:{id:string;fingerprint:string}){
 check(source.id!==destination.id&&source.device.keys.fingerprint!==destination.fingerprint,'DIFFERENT_ACCOUNT_AND_KEYS_REQUIRED');
}
export function importSourceKey(member:string,kind:string,id:string){return `${member}:${kind}:${id}`;}
/** A successful main-path signout must not be repeated as an authenticated cleanup request. */
export async function endSessionOnce(state:{ended:boolean},end:()=>Promise<void>){
 if(state.ended)return;
 await end();state.ended=true;
}
