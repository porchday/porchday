import type { Context, Hono } from 'hono';
import { z } from 'zod';
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
  checkEnvelope(db:Db,member:string,envelope:EncryptedEnvelope,kind:string,options?:{postId?:string;allowPast?:boolean}):Promise<unknown>;
}
export const MAX_MEDIA_BYTES=22_020_096;
export async function envelopeDigest(envelope:EncryptedEnvelope):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(envelope)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
/** Ciphertext lives once, in private R2. PostgreSQL retains only authenticated routing fields and a digest. */
export function mediaRouting(envelope:EncryptedEnvelope) {
  const {ciphertext:_,...routing}=envelope;return routing;
}
export function registerMediaRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,deps:MediaDependencies) {
  const {tx,body,checkEnvelope,writeAllowed,fail,id}=deps;
  app.post('/media',async c=>{
    const b=await body(c,z.object({id:z.string().uuid(),envelope:envelopeSchema,byte_size:z.number().int().min(1).max(MAX_MEDIA_BYTES)}).strict(),25*1024*1024);
    const digest=await envelopeDigest(b.envelope);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);
      if(b.id!==b.envelope.context.id||b.envelope.context.parentId===null)fail('ENVELOPE_CONTEXT');
      await checkEnvelope(db,c.get('memberId'),b.envelope,'media',{allowPast:b.envelope.context.audience==='only_me'});
      // Preserve directory-before-profile lock order while serializing quota reservations.
      await db`select member_id from app.profiles where member_id=${c.get('memberId')} for update`;
      const [quota]=await db`select coalesce(sum(byte_size),0)::bigint as bytes from app.media_assets where owner_id=${c.get('memberId')}`;
      if(Number(quota.bytes)+b.byte_size>1024*1024*1024)fail('MEDIA_QUOTA',413);
      await db`insert into app.media_assets(id,owner_id,object_key,envelope,envelope_sha256,byte_size,state) values(${b.id},${c.get('memberId')},${'media/'+c.get('memberId')+'/'+b.id},${db.json(JSON.parse(canonicalJson(mediaRouting(b.envelope))))},${digest},${b.byte_size},'pending')`;
      return {id:b.id,upload_url:'/api/v1/media/'+b.id+'/bytes'};
    }),201);
  });
  app.put('/media/:id/bytes',async c=>{
    const mediaId=id(c.req.param('id'));
    if(c.req.header('content-type')?.split(';')[0]!=='application/octet-stream')fail('CONTENT_TYPE');
    const bytes=new Uint8Array(await c.req.arrayBuffer());
    if(bytes.byteLength>MAX_MEDIA_BYTES)fail('PAYLOAD_TOO_LARGE',413);
    let envelope:EncryptedEnvelope;
    try{envelope=envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)));}catch{return fail('INVALID_MEDIA_ENVELOPE');}
    const digest=await envelopeDigest(envelope);
    let written:string|undefined;
    try{return c.json(await tx(c,async db=>{
      await writeAllowed(db);
      const [m]=await db`select * from app.media_assets where id=${mediaId} and owner_id=${c.get('memberId')} and state='pending' for update`;
      if(!m)fail('NOT_FOUND',404);
      if(Number(m.byte_size)!==bytes.byteLength||m.envelope_sha256!==digest||canonicalJson(m.envelope)!==canonicalJson(mediaRouting(envelope)))fail('MEDIA_UPLOAD_MISMATCH',409);
      if(envelope.context.expiresAt&&Date.parse(envelope.context.expiresAt)<=Date.now())fail('EXPIRED',409);
      await c.env.MEDIA.put(m.object_key,bytes,{httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});
      written=m.object_key;
      await db`update app.media_assets set state='ready' where id=${mediaId}`;
      return {ok:true};
    }));}catch(error){if(written)await c.env.MEDIA.delete(written);throw error;}
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
