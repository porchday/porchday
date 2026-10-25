import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isAscii } from 'node:buffer';
import { parseMediaJson } from './media-json.js';
export { parseMediaJson } from './media-json.js';
import { canonicalJson, type EncryptedEnvelope } from '@porchday/crypto';
import { envelopeSchema } from './social-contract.js';
import type { Db } from './db.js';
import type { Env, Variables } from './types.js';

export type SocialContext = Context<{ Bindings: Env; Variables: Variables }>;
export interface RouteDependencies {
  tx<T>(c:SocialContext, work:(db:Db)=>Promise<T>):Promise<T>;
  fail(code:string,status?:400|403|404|409|413|429,details?:unknown):never;
  id(raw:string|undefined):string;
}
interface MediaDependencies extends RouteDependencies {
  body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;
  writeAllowed(db:Db):Promise<void>;
  checkEnvelope(db:Db,member:string,envelope:Pick<EncryptedEnvelope,'context'|'recipients'>,kind:string,options?:{postId?:string;allowPast?:boolean}):Promise<unknown>;
}
export const MAX_MEDIA_BYTES=22_020_096;
export const MEDIA_UPLOAD_TIMEOUT_MS=120_000;
let parsingMedia=false;
export async function withMediaMemoryPermit<T>(work:()=>Promise<T>,busy:()=>never):Promise<T> {
  if(parsingMedia)return busy();parsingMedia=true;
  try{return await work();}finally{parsingMedia=false;}
}
export async function envelopeDigest(envelope:EncryptedEnvelope):Promise<string> {
  // In the validated v1 schema, ciphertext is the first sorted root property.
  // Keep the established canonicalJson encoding, but feed its large string in
  // bounded pieces to the maintained native SHA-256 implementation. Splitting
  // only between complete UTF-16 characters preserves JSON.stringify's exact
  // treatment of paired and unpaired surrogates.
  const hash=createHash('sha256');hash.update('{"ciphertext":"');
  for(let start=0;start<envelope.ciphertext.length;){
    let end=Math.min(start+16384,envelope.ciphertext.length);
    const last=envelope.ciphertext.charCodeAt(end-1),next=envelope.ciphertext.charCodeAt(end);
    if(end<envelope.ciphertext.length&&last>=0xd800&&last<=0xdbff&&next>=0xdc00&&next<=0xdfff)end--;
    hash.update(canonicalJson(envelope.ciphertext.slice(start,end)).slice(1,-1));start=end;
  }
  hash.update('",');hash.update(canonicalJson(mediaRouting(envelope)).slice(1));
  return hash.digest('hex');
}
/** Ciphertext lives once, in private R2. PostgreSQL retains only authenticated routing fields and a digest. */
export function mediaRouting(envelope:EncryptedEnvelope) {
  const {ciphertext:_,...routing}=envelope;return routing;
}
/** Count actual streamed bytes, without Hono's retained body cache or a second
 * whole-body UTF-8 allocation merely to determine its length. The two media
 * routes are excluded from the global buffering body-limit middleware. */
export function limitedMediaBody(request:Request,maxBytes:number,fail:RouteDependencies['fail'],signal?:AbortSignal):Response {
  if(Number(request.headers.get('content-length')??0)>maxBytes)fail('PAYLOAD_TOO_LARGE',413);
  if(!request.body)return new Response(null);
  let size=0;
  return new Response(request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
    size+=chunk.byteLength;if(size>maxBytes)fail('PAYLOAD_TOO_LARGE',413);controller.enqueue(chunk);
  }}),{signal}));
}
const reservationSchema=z.object({id:z.string().uuid(),envelope:envelopeSchema,byte_size:z.number().int().min(1).max(MAX_MEDIA_BYTES)}).strict();
async function reservationBody(request:Request,fail:RouteDependencies['fail']) {
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(Error('MEDIA_UPLOAD_EXPIRED')),MEDIA_UPLOAD_TIMEOUT_MS);
  try{const b=reservationSchema.parse(await parseMediaJson(limitedMediaBody(request,25*1024*1024,fail,abort.signal).body,25*1024*1024,fail));
    return {id:b.id,byte_size:b.byte_size,routing:mediaRouting(b.envelope),digest:await envelopeDigest(b.envelope)};
  }catch(error){if(abort.signal.aborted)fail('MEDIA_UPLOAD_EXPIRED',409);throw error;}
  finally{clearTimeout(timer);abort.abort();}
}
export async function uploadMetadata(object:Pick<R2ObjectBody,'body'>,deadline:number,fail:RouteDependencies['fail']) {
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(Error('MEDIA_UPLOAD_EXPIRED')),Math.max(1,deadline-Date.now()));
  let envelope:EncryptedEnvelope;
  try{
    const bounded=object.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>(),{signal:abort.signal});
    envelope=envelopeSchema.parse(await parseMediaJson(bounded,MAX_MEDIA_BYTES,fail));
    if(Date.now()>=deadline)return fail('MEDIA_UPLOAD_EXPIRED',409);
    return {routing:mediaRouting(envelope),digest:await envelopeDigest(envelope)};
  }catch(error){if(abort.signal.aborted||Date.now()>=deadline)return fail('MEDIA_UPLOAD_EXPIRED',409);return fail('INVALID_MEDIA_ENVELOPE');}
  finally{clearTimeout(timer);abort.abort();}
}
export async function streamPendingMedia(request:Request,bucket:R2Bucket,key:string,size:number,deadline:number,fail:RouteDependencies['fail'],written:(etag:string)=>void):Promise<string> {
  const body=limitedMediaBody(request,MAX_MEDIA_BYTES,fail).body;if(!body)fail('MEDIA_UPLOAD_MISMATCH',409);
  const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}),abort=new AbortController();let received=0,timedOut=false,collision=false,unicode=false,pumpingError:unknown;
  // Native R2 requires a known-length stream. The fallback exists only for
  // Node test/development adapters, and has the same exact-length checks below.
  const fixed=typeof FixedLengthStream==='function'?new FixedLengthStream(size):new TransformStream<Uint8Array,Uint8Array>();
  const timer=setTimeout(()=>{timedOut=true;abort.abort(Error('MEDIA_UPLOAD_EXPIRED'));},Math.max(1,deadline-Date.now()));
  const pumping=body!.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
    received+=chunk.byteLength;if(received>size)fail('MEDIA_UPLOAD_MISMATCH',409);
    hash.update(chunk);
    try{if(unicode||!isAscii(chunk)){unicode=true;for(let offset=0;offset<chunk.byteLength;offset+=16384)decoder.decode(chunk.subarray(offset,offset+16384),{stream:true});}}catch{fail('INVALID_MEDIA_ENVELOPE');}
    controller.enqueue(chunk);
  },flush(){try{decoder.decode();}catch{fail('INVALID_MEDIA_ENVELOPE');}if(received!==size)fail('MEDIA_UPLOAD_MISMATCH',409);}})).pipeTo(fixed.writable,{signal:abort.signal});
  // Attach immediately: a failed source may reject before R2 completes.
  void pumping.catch(error=>{pumpingError=error;});
  try{
    const object=await bucket.put(key,fixed.readable,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});
    if(!object){collision=true;abort.abort();await pumping.catch(()=>{});fail('MEDIA_UPLOAD_IN_PROGRESS',409);}
    written(object!.etag);await pumping;
    if(Date.now()>=deadline)fail('MEDIA_UPLOAD_EXPIRED',409);
    return hash.digest('hex');
  }catch(error){abort.abort();await pumping.catch(()=>{});if(collision)fail('MEDIA_UPLOAD_IN_PROGRESS',409);if(timedOut)fail('MEDIA_UPLOAD_EXPIRED',409);throw pumpingError??error;}
  finally{clearTimeout(timer);abort.abort();await pumping.catch(()=>{});}
}
export function registerMediaRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,deps:MediaDependencies) {
  const {tx,body,checkEnvelope,writeAllowed,fail,id}=deps;
  const memory=<T>(c:SocialContext,work:()=>Promise<T>)=>withMediaMemoryPermit(work,()=>{c.header('Retry-After','1');return fail('MEDIA_BUSY',429);});
  app.post('/media',async c=>{
    const b=await memory(c,()=>reservationBody(c.req.raw,fail));
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);
      if(b.id!==b.routing.context.id||b.routing.context.parentId===null)fail('ENVELOPE_CONTEXT');
      await checkEnvelope(db,c.get('memberId'),b.routing,'media',{allowPast:b.routing.context.audience==='only_me'});
      // Preserve directory-before-profile lock order while serializing quota reservations.
      await db`select member_id from app.profiles where member_id=${c.get('memberId')} for update`;
      const [quota]=await db`select coalesce(sum(byte_size),0)::bigint as bytes from app.media_assets where owner_id=${c.get('memberId')}`;
      if(Number(quota.bytes)+b.byte_size>1024*1024*1024)fail('MEDIA_QUOTA',413);
      await db`insert into app.media_assets(id,owner_id,object_key,envelope,envelope_sha256,byte_size,state) values(${b.id},${c.get('memberId')},${'media/'+c.get('memberId')+'/'+b.id},${db.json(JSON.parse(canonicalJson(b.routing)))},${b.digest},${b.byte_size},'pending')`;
      return {id:b.id,upload_url:'/api/v1/media/'+b.id+'/bytes'};
    }),201);
  });
  app.put('/media/:id/bytes',async c=>{
    const mediaId=id(c.req.param('id'));
    if(c.req.header('content-type')?.split(';')[0]!=='application/octet-stream')fail('CONTENT_TYPE');
    const deadline=Date.now()+MEDIA_UPLOAD_TIMEOUT_MS;
    const m=await tx(c,async db=>{await writeAllowed(db);const[row]=await db`select * from app.media_assets where id=${mediaId} and owner_id=${c.get('memberId')} and state='pending'`;if(!row)fail('NOT_FOUND',404);return row;});
    let ownedEtag:string|undefined;
    try{
      const rawDigest=await streamPendingMedia(c.req.raw,c.env.MEDIA,m.object_key,Number(m.byte_size),deadline,fail,etag=>{ownedEtag=etag;});
      const object=await c.env.MEDIA.get(m.object_key);if(!object||object.etag!==ownedEtag||object.size!==Number(m.byte_size))fail('MEDIA_UPLOAD_MISMATCH',409);
      let reading=false;const {routing,digest}=await (async()=>{try{return await memory(c,()=>{reading=true;return uploadMetadata(object!,deadline,fail);});}finally{if(!reading)await object!.body.cancel().catch(()=>{});}})();
      if(m.envelope_sha256!==digest||canonicalJson(m.envelope)!==canonicalJson(routing))fail('MEDIA_UPLOAD_MISMATCH',409);
      return c.json(await tx(c,async db=>{
        await writeAllowed(db);
        const[row]=await db`select id from app.media_assets where id=${mediaId} and owner_id=${c.get('memberId')} and state='pending' and object_key=${m.object_key} and envelope_sha256=${digest} for update`;
        if(!row)fail('NOT_FOUND',404);
        if(Date.now()>=deadline)fail('MEDIA_UPLOAD_EXPIRED',409);
        if(routing.context.expiresAt&&Date.parse(routing.context.expiresAt)<=Date.now())fail('EXPIRED',409);
        await db`update app.media_assets set state='ready',raw_sha256=${rawDigest} where id=${mediaId}`;
        return {ok:true};
      }));
    }catch(error){
      if(ownedEtag)try{
        // This narrow helper sees owner state even if RLS changed, and waits for
        // an ambiguous COMMIT's row lock. Never delete a ready/attached object.
        await tx(c,async db=>{const[row]=await db`select app.lock_media_upload_cleanup(${mediaId}) as state`;if(!['pending','deleted'].includes(row?.state))return;const object=await c.env.MEDIA.head(m.object_key);if(object?.etag===ownedEtag)await c.env.MEDIA.delete(m.object_key);});
      }catch{/* Keep private bytes for durable abandoned/deletion cleanup. */}
      throw error;
    }
  });
  app.get('/media/:id/bytes',async c=>{
    const m=await tx(c,async db=>{const [row]=await db`select object_key from app.media_assets where id=${id(c.req.param('id'))} and state in('ready','attached')`;if(!row)fail('NOT_FOUND',404);return row;});
    const object=await c.env.MEDIA.get(m.object_key);if(!object)return fail('NOT_FOUND',404);
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  });
  app.put('/media/:id/attachment',async c=>{
    const b=await body(c,z.object({kind:z.enum(['profile','group']),target_id:z.string().uuid(),slot:z.enum(['avatar','cover','background','image'])}).strict());
    return c.json(await tx(c,async db=>{await db`select app.attach_surface_media(${id(c.req.param('id'))},${b.kind},${b.target_id},${b.slot})`;return {ok:true};}));
  });
  app.delete('/media/:id',async c=>c.json(await tx(c,async db=>{
    await db`delete from app.media_assets where id=${id(c.req.param('id'))} and owner_id=${c.get('memberId')} and post_id is null`;return {ok:true};
  })));
}
