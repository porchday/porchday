import {MEMBER_MEDIA_BYTES,VIDEO_SOURCE_BYTES} from './media-limits.js';
import type {Hono} from 'hono';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@porchday/crypto';
import {envelopeSchema} from './social-contract.js';
import {envelopeDigest,mediaRouting,limitedMediaBody,type MediaDependencies,type SocialContext} from './social-media.js';
import type {Env,Variables} from './types.js';
const CHUNK=4*1024*1024,MAX=250*1024*1024,QUOTA=MEMBER_MEDIA_BYTES;
const segment=z.object({index:z.number().int().min(0).max(62),size:z.number().int().min(17).max(CHUNK+16),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const videoSpecification=z.array(segment).min(1).max(63).refine(parts=>parts.every((p,i)=>p.index===i&&(i===parts.length-1||p.size===CHUNK+16))&&parts.reduce((n,p)=>n+p.size-16,0)<=MAX,'Invalid video segments');
const reservation=z.object({id:z.uuid(),envelope:envelopeSchema,byte_size:z.number().int().min(1).max(1024*1024),stream_id:z.uuid(),segments:videoSpecification.optional(),photo_refresh_id:z.uuid().optional(),history_post_id:z.uuid().optional(),history_source_revision:z.number().int().positive().optional()}).strict().refine(b=>(b.history_post_id===undefined)===(b.history_source_revision===undefined));
/** Immutable ciphertext writer. Hash verification precedes R2 commit; retrying an
 * uncertain PUT reads the same object instead of deleting or overwriting it. */
export async function putVideoChunk(request:Request,bucket:R2Bucket,row:{object_key:string;byte_size:number;sha256:string},fail:MediaDependencies['fail']){
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),120000);let written=0;const hash=createHash('sha256');
 const body=limitedMediaBody(request,row.byte_size,fail,abort.signal).body;if(!body){clearTimeout(timer);fail('VIDEO_CHUNK_MISMATCH',409);}
 const fixed=typeof FixedLengthStream==='function'?new FixedLengthStream(row.byte_size):new TransformStream<Uint8Array,Uint8Array>();
 const pumping=body!.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(bytes,controller){written+=bytes.length;hash.update(bytes);controller.enqueue(bytes);},flush(){if(written!==row.byte_size||hash.digest('hex')!==row.sha256)fail('VIDEO_CHUNK_MISMATCH',409);}})).pipeTo(fixed.writable,{signal:abort.signal});void pumping.catch(()=>{});
 try{
  const result=await bucket.put(row.object_key,fixed.readable,{onlyIf:{etagDoesNotMatch:'*'},sha256:row.sha256,httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});
  if(!result){abort.abort();await pumping.catch(()=>{});const existing=await bucket.get(row.object_key);if(!existing||existing.size!==row.byte_size)fail('VIDEO_CHUNK_MISMATCH',409);const digest=createHash('sha256');for await(const chunk of existing.body)digest.update(chunk);if(digest.digest('hex')!==row.sha256)fail('VIDEO_CHUNK_MISMATCH',409);return;}
  await pumping;
 }finally{clearTimeout(timer);abort.abort();await pumping.catch(()=>{});}
}
export function registerVideoRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,deps:MediaDependencies){
 const{tx,body,checkEnvelope,writeAllowed,fail,id}=deps;
 function publishing(c:SocialContext){if(c.env.VIDEO_UPLOADS_V2!=='true'||c.env.MEDIA_UPLOADS_PAUSED==='true'||c.env.CONTENT_WRITES_PAUSED==='true')fail('VIDEO_PUBLISHING_UNAVAILABLE',409);}
 app.get('/videos/capabilities',c=>c.json({version:2,enabled:c.env.VIDEO_UPLOADS_V2==='true'&&c.env.MEDIA_UPLOADS_PAUSED!=='true'&&c.env.CONTENT_WRITES_PAUSED!=='true',direct_uploads:true,member_media_bytes:QUOTA,max_source_bytes:VIDEO_SOURCE_BYTES,max_bytes:MAX,max_seconds:600,chunk_bytes:CHUNK}));
 app.post('/videos',async c=>{
  publishing(c);const b=await body(c,reservation,2*1024*1024),routing=mediaRouting(b.envelope),digest=await envelopeDigest(b.envelope);
  if(b.id!==routing.context.id||routing.context.parentId===null||['photo','moderators'].includes(routing.context.audience))fail('ENVELOPE_CONTEXT');
  return c.json(await tx(c,async db=>{
   await writeAllowed(db);await checkEnvelope(db,c.get('memberId'),routing,'media',{allowPast:routing.context.audience==='only_me',historyPostId:b.history_post_id,historySourceRevision:b.history_source_revision,photoRefreshId:b.photo_refresh_id});
   await db`select member_id from app.profiles where member_id=${c.get('memberId')} for update`;
   const[old]=await db`select * from app.media_assets where id=${b.id} and owner_id=${c.get('memberId')}`;
   if(old){const[stream]=await db`select specification from app.video_streams where id=${b.stream_id}`;if(old.envelope_sha256!==digest||old.video_stream_id!==b.stream_id||Number(old.byte_size)!==b.byte_size||!stream||b.segments&&canonicalJson(stream.specification)!==canonicalJson(b.segments))fail('VIDEO_OPERATION_CONFLICT',409);return{id:b.id,upload_url:'/api/v1/media/'+b.id+'/bytes',state:old.state};}
   const[existing]=await db`select * from app.video_streams where id=${b.stream_id} and (owner_id=${c.get('memberId')} or app.can_rewrap_photo_video(id,${db.json(JSON.parse(canonicalJson(routing)))}))`;
   if(existing&&(!existing.complete||b.segments&&canonicalJson(existing.specification)!==canonicalJson(b.segments)))fail('VIDEO_OPERATION_CONFLICT',409);
   if(!existing&&!b.segments)fail('NOT_FOUND',404);
   const bytes=b.segments?.reduce((n,p)=>n+p.size,0)??0;
   const[quota]=await db`select (select coalesce(sum(byte_size),0) from app.media_assets where owner_id=${c.get('memberId')})+(select coalesce(sum(byte_size),0) from app.video_streams where owner_id=${c.get('memberId')}) as bytes`;
   if(Number(quota.bytes)+b.byte_size+(existing?0:bytes)>QUOTA)fail('MEDIA_QUOTA',413);
   if(!existing){
    await db`insert into app.video_streams(id,owner_id,byte_size,specification) values(${b.stream_id},${c.get('memberId')},${bytes},${db.json(b.segments!)})`;
    for(const part of b.segments!){const chunk=crypto.randomUUID();await db`insert into app.video_chunks(id,stream_id,owner_id,chunk_index,byte_size,sha256,object_key) values(${chunk},${b.stream_id},${c.get('memberId')},${part.index},${part.size},${part.sha256},${'media/'+c.get('memberId')+'/'+chunk})`;}
   }
   await db`insert into app.media_assets(id,owner_id,object_key,envelope,envelope_sha256,byte_size,state,video_stream_id) values(${b.id},${c.get('memberId')},${'media/'+c.get('memberId')+'/'+b.id},${db.json(JSON.parse(canonicalJson(routing)))},${digest},${b.byte_size},'pending',${b.stream_id})`;
   return{id:b.id,upload_url:'/api/v1/media/'+b.id+'/bytes',state:'pending'};
  }),201);
 });
 app.get('/videos/:id/access',async c=>c.json(await tx(c,async db=>{const[m]=await db`select app.media_deadline(id) as deadline from app.media_assets where id=${id(c.req.param('id'))} and state in('ready','attached') and video_stream_id is not null and app.can_video_stream(video_stream_id)`;if(!m)fail('NOT_FOUND',404);return{ok:true,expiresAt:m.deadline};})));
 app.get('/videos/:id/status',async c=>c.json(await tx(c,async db=>{
  const[m]=await db`select m.id,m.state,s.complete,s.specification from app.media_assets m join app.video_streams s on s.id=m.video_stream_id where m.id=${id(c.req.param('id'))} and m.owner_id=${c.get('memberId')}`;if(!m)fail('NOT_FOUND',404);
  const parts=await db`select chunk_index from app.video_chunks where stream_id=(select video_stream_id from app.media_assets where id=${m.id}) and received_at is not null order by chunk_index`;
  return{state:m.state,complete:m.complete,received:parts.map(p=>p.chunk_index),segments:m.specification};
 })));
 app.put('/videos/:id/chunks/:index',async c=>{
  publishing(c);const mediaId=id(c.req.param('id')),index=Number(c.req.param('index'));if(!Number.isSafeInteger(index)||index<0||index>62)fail('INVALID_VIDEO_CHUNK');
  if(c.req.header('content-type')?.split(';')[0]!=='application/octet-stream')fail('CONTENT_TYPE');
  const row=await tx(c,async db=>{await writeAllowed(db);const[r]=await db`select v.* from app.video_chunks v join app.media_assets m on m.video_stream_id=v.stream_id where m.id=${mediaId} and m.owner_id=${c.get('memberId')} and v.chunk_index=${index} and app.can_video_stream(v.stream_id)`;if(!r)fail('NOT_FOUND',404);return r;});
  if(row.received_at){await c.req.raw.body?.cancel();return c.json({ok:true});}
  await putVideoChunk(c.req.raw,c.env.MEDIA,{object_key:row.object_key,sha256:row.sha256,byte_size:Number(row.byte_size)},fail);
  return c.json(await tx(c,async db=>{await writeAllowed(db);const[s]=await db`select * from app.video_streams where id=${row.stream_id} and owner_id=${c.get('memberId')} for update`;if(!s)fail('NOT_FOUND',404);await db`update app.video_chunks set received_at=now() where id=${row.id} and received_at is null`;return{ok:true};}));
 });
 app.post('/videos/:id/complete',async c=>{
  publishing(c);return c.json(await tx(c,async db=>{await writeAllowed(db);const[s]=await db`select s.* from app.video_streams s join app.media_assets m on m.video_stream_id=s.id where m.id=${id(c.req.param('id'))} and m.owner_id=${c.get('memberId')} for update of s`;if(!s)fail('NOT_FOUND',404);if(!s.complete)await db`update app.video_streams set complete=true where id=${s.id}`;return{ok:true};}));
 });
 app.get('/videos/:id/chunks/:index',async c=>{
  const index=Number(c.req.param('index'));if(!Number.isSafeInteger(index)||index<0||index>62)fail('NOT_FOUND',404);
  const row=await tx(c,async db=>{const[r]=await db`select v.object_key,v.byte_size,v.sha256 from app.media_assets m join app.video_streams s on s.id=m.video_stream_id join app.video_chunks v on v.stream_id=s.id where m.id=${id(c.req.param('id'))} and m.state in('ready','attached') and s.complete and v.received_at is not null and v.chunk_index=${index} and app.can_video_stream(s.id)`;if(!r)fail('NOT_FOUND',404);return r;});
  const object=await c.env.MEDIA.get(row.object_key);if(!object||object.size!==Number(row.byte_size))fail('NOT_FOUND',404);
  return new Response(object!.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Length':String(row.byte_size)}});
 });
 app.delete('/videos/:id',async c=>c.json(await tx(c,async db=>{
  const[m]=await db`select * from app.media_assets where id=${id(c.req.param('id'))} and owner_id=${c.get('memberId')} for update`;if(!m)return{ok:true};if(m.state==='attached'||m.post_id)fail('VIDEO_ALREADY_PUBLISHED',409);
  await db`delete from app.media_assets where id=${m.id}`;
  await db`delete from app.video_streams s where s.id=${m.video_stream_id} and s.owner_id=${c.get('memberId')} and not exists(select 1 from app.media_assets m where m.video_stream_id=s.id)`;return{ok:true};
 })));
}
