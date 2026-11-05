import type {Hono} from "hono";
import {z} from "zod";
import type {EncryptedEnvelope} from "@porchday/crypto";
import type {Db} from "./db";
import {envelopeSchema} from "./social-contract";
import type {RouteDependencies,SocialContext} from "./social-media";
import type {Env,Variables} from "./types";
interface Dependencies extends RouteDependencies {
 body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;
 writeAllowed(db:Db):Promise<void>;
 checkEnvelope(db:Db,member:string,e:EncryptedEnvelope,kind:string,options?:{photoInteractionId?:string}):Promise<unknown>;
}
export async function photoInteractionSnapshot(db:Db,photo:string){
 const [lock]=await db`select app.lock_epoch() as epoch`;
 const devices=await db`select * from app.photo_interaction_devices(${photo}::uuid)`;
 const members=await db`select * from app.photo_interaction_members(${photo}::uuid)`;
 const keyed=new Set(devices.map(d=>d.member_id));
 return {epoch:Number(lock.epoch),devices,pending_members:members.filter(m=>!keyed.has(m.member_id)).map(m=>m.member_id)};
}
export function registerPhotoInteractionRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body,fail,id,writeAllowed,checkEnvelope}:Dependencies){
 async function requirePhoto(db:Db,p:string){const [photo]=await db`select * from app.photos where id=${p}`;if(!photo)fail("NOT_FOUND",404);return photo;}
 app.get('/photos/:id/interactions/audience',async c=>c.json(await tx(c,async db=>{const p=id(c.req.param('id'));await requirePhoto(db,p);return photoInteractionSnapshot(db,p);}))); 
 app.get('/photos/:id/interactions',async c=>c.json(await tx(c,async db=>{
  const p=id(c.req.param('id'));await requirePhoto(db,p);
  const after=c.req.query('after');let cursor:{at:string;id:string}|undefined;
  if(after){try{cursor=z.object({at:z.string().datetime({offset:true}),id:z.string().uuid()}).strict().parse(JSON.parse(after));}catch{fail('INVALID_CURSOR');}}
  const rows=await db`select i.*,to_char(i.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,h.handle as author_handle from app.photo_interactions i left join lateral app.member_handles(array[i.author_id]) h on true where photo_id=${p} ${cursor?db`and (i.created_at,i.id)>(${cursor.at}::timestamptz,${cursor.id}::uuid)`:db``} order by i.created_at,i.id limit 101`;
  const selected=rows.slice(0,100);return {items:selected,next:rows.length>100?JSON.stringify({at:selected[99].cursor_at,id:selected[99].id}):null};
 })));
 app.post('/photos/:id/interactions',async c=>{
  const b=await body(c,z.object({envelope:envelopeSchema}).strict(),600000),p=id(c.req.param('id')),e=b.envelope.context;
  return c.json(await tx(c,async db=>{
   await writeAllowed(db);await db`select app.lock_epoch()`;const photo=await requirePhoto(db,p);id(e.id);
   if(!['comment','reaction'].includes(e.kind)||e.parentId!==p||e.audience!=='photo'||e.groupId!==null||e.revision!==1)fail('ENVELOPE_CONTEXT');
   if((e.expiresAt?Date.parse(e.expiresAt):null)!==(photo.expires_at?new Date(photo.expires_at).getTime():null))fail('INHERITED_DEADLINE');
   const [removed]=await db`select app.photo_interaction_removed(${p}::uuid,${e.id}::uuid) as removed`;if(removed.removed)fail("INTERACTION_REMOVED",409);
   const [existing]=await db`select * from app.photo_interactions where id=${e.id}`;
   if(existing){if(existing.author_id!==c.get('memberId')||existing.photo_id!==p||JSON.stringify(existing.envelope)!==JSON.stringify(b.envelope)){
     // JSONB key order is not significant; compare in SQL instead.
     const [same]=await db`select id from app.photo_interactions where id=${e.id} and photo_id=${p} and author_id=${c.get('memberId')} and envelope=${db.json(b.envelope)}`;
     if(!same)fail('INTERACTION_CHANGED',409);
   }return {id:e.id};}
   await checkEnvelope(db,c.get('memberId'),b.envelope,e.kind,{photoInteractionId:p});
   const [key]=await db`select id,member_id,public_key,fingerprint from app.device_keys where id=${e.authorDeviceId} and member_id=${c.get('memberId')} and revoked_at is null`;
   if(e.kind==='reaction')await db`delete from app.photo_interactions where photo_id=${p} and author_id=${c.get('memberId')} and kind='reaction'`;
   await db`insert into app.photo_interactions(id,photo_id,author_id,kind,envelope,author_key) values(${e.id},${p},${c.get('memberId')},${e.kind},${db.json(b.envelope)},${db.json(key)})`;
   return {id:e.id};
  }),201);
 });
 app.delete('/photos/:id/interactions/:interaction',async c=>c.json(await tx(c,async db=>{
  await writeAllowed(db);const p=id(c.req.param('id'));await requirePhoto(db,p);
  await db`delete from app.photo_interactions where id=${id(c.req.param('interaction'))} and photo_id=${p}`;return {ok:true};
 })));
}
