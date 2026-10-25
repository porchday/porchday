import {check} from './hosted-smoke-support.js';
import type {EncryptedEnvelope} from '@porchday/crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ArchiveSource={id:string;journal_kind:string;created_at:string;expires_at:string|null};
export type ArchiveBoundary={member:string;device:string;originalIds:Set<string>;sources:Map<string,ArchiveSource>;media:Map<string,{parentId:string}>;posts:Set<string>};
export type CapturedPost={id:string;source:string;createdAt:string;expiresAt:string|null;mediaIds:string[]};
function binding(e:EncryptedEnvelope,b:ArchiveBoundary,kind:'post'|'media'){
 const c=e?.context;
 check(e?.v===1&&e.protocol==='porchday-openpgp-v1'&&typeof e.ciphertext==='string'&&c?.kind===kind&&uuid.test(c.id)&&
  c.authorId===b.member&&c.authorDeviceId===b.device&&c.audience==='only_me'&&c.groupId===null&&c.revision===1&&
  !b.originalIds.has(c.id)&&Array.isArray(e.recipients)&&e.recipients.length>0&&e.recipients.length<=8&&
  e.recipients.every(r=>r.memberId===b.member),'ARCHIVE_PRIVATE_WRITE_REQUIRED');
 return c;
}
/** Inspect only; never alter or synthesize the UI's encrypted request. */
export function captureArchiveMedia(body:any,b:ArchiveBoundary){
 const c=binding(body?.envelope,b,'media');
 check(body.id===c.id&&uuid.test(c.parentId||'')&&!b.originalIds.has(c.parentId!)&&!b.media.has(c.id)&&
  b.media.size<32&&Number.isSafeInteger(body.byte_size)&&body.byte_size>0&&body.byte_size<=2*1024*1024,'ARCHIVE_MEDIA_BOUNDARY');
 return {id:c.id,parentId:c.parentId!,createdAt:c.createdAt,expiresAt:c.expiresAt};
}
export function captureArchiveImport(body:any,b:ArchiveBoundary):{jobId:string;posts:CapturedPost[]}{
 check(body&&!('profile'in body)&&uuid.test(body.id)&&Array.isArray(body.posts)&&body.posts.length>0&&
  body.posts.length<=50&&b.posts.size+body.posts.length<=100,'ARCHIVE_IMPORT_BOUNDARY');
 const seen=new Set<string>(),sources=new Set<string>();
 const posts=body.posts.map((p:any)=>{
  const c=binding(p.envelope,b,'post'),source=b.sources.get(p.source_id);
  check(source&&c.parentId===null&&!b.posts.has(c.id)&&!seen.has(c.id)&&!sources.has(p.source_id)&&
   c.createdAt===new Date(source.created_at).toISOString()&&c.expiresAt===(source.expires_at?new Date(source.expires_at).toISOString():null)&&
   Array.isArray(p.media_ids)&&p.media_ids.length<=10&&new Set(p.media_ids).size===p.media_ids.length&&
   p.media_ids.every((id:string)=>b.media.get(id)?.parentId===c.id),'ARCHIVE_IMPORT_SOURCE_MISMATCH');
  seen.add(c.id);sources.add(p.source_id);
  return {id:c.id,source:p.source_id,createdAt:c.createdAt,expiresAt:c.expiresAt,mediaIds:[...p.media_ids]};
 });
 return {jobId:body.id,posts};
}
