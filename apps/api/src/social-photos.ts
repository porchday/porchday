import {attachmentDateProof,setAttachmentDate} from "./attachment-photo-dates";
import type { Hono } from "hono";
import { z } from "zod";
import type { EncryptedEnvelope } from "@porchday/crypto";
import type { Db } from "./db";
import { envelopeSchema } from "./social-contract";
import type { RouteDependencies, SocialContext } from "./social-media";
import type { Env, Variables } from "./types";
interface Dependencies extends RouteDependencies {
  body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;
  writeAllowed(db:Db):Promise<void>;
  checkEnvelope(db:Db,member:string,e:EncryptedEnvelope,kind:string,options?:{allowPast?:boolean;photoGrantId?:string;photoRefreshId?:string}):Promise<unknown>;
}
const day=z.string().date().refine(d=>d>="0001-01-01"&&d<="9999-12-31");
const grantSchema=z.object({envelope:envelopeSchema,media_id:z.string().uuid()}).strict();
export async function photoGrantSnapshot(db:Db,grant:string) {
  const [lock]=await db`select app.lock_epoch() as epoch`;
  const devices=await db`select * from app.photo_grant_audience_devices(${grant}::uuid)`;
  const members=await db`select * from app.photo_grant_audience_members(${grant}::uuid)`;
  const keyed=new Set(devices.map(d=>d.member_id));
  return {epoch:Number(lock.epoch),devices,pending_members:members.filter(m=>!keyed.has(m.member_id)).map(m=>m.member_id)};
}
export async function photoRefreshSnapshot(db:Db,grant:string) {
 const [lock]=await db`select app.lock_epoch() as epoch`;
 const devices=await db`select * from app.photo_refresh_devices(${grant}::uuid)`;
 const members=await db`select * from app.photo_refresh_members(${grant}::uuid)`;
 const keyed=new Set(devices.map(d=>d.member_id));
 return {epoch:Number(lock.epoch),devices,pending_members:members.filter(m=>!keyed.has(m.member_id)).map(m=>m.member_id)};
}
export function registerPhotoRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body,fail,id,writeAllowed,checkEnvelope}:Dependencies) {
  async function requirePhoto(db:Db,photo:string) {
    const [row]=await db`select *,photo_date::text as photo_date from app.photos where id=${photo}`;
    if(!row)fail("NOT_FOUND",404);return row;
  }
  function context(envelope:EncryptedEnvelope,p:{id:string;photo_date:string;expires_at:unknown;revision:number}) {
    const c=envelope.context;
    if(c.kind!=="photo"||c.parentId!==p.id||c.photoDate!==p.photo_date||c.revision!==p.revision||
      (c.expiresAt===null?null:Date.parse(c.expiresAt))!==(p.expires_at===null?null:new Date(p.expires_at as string).getTime())||
      !["only_me","connections","friends","family","album"].includes(c.audience)||
      (c.audience==="album")!==(c.groupId!==null))fail("ENVELOPE_CONTEXT");
    id(c.id);
  }
  async function grants(db:Db,photo:string){return db`select * from app.photo_grants where photo_id=${photo} order by id`;}
  app.get("/media/:id/photo-date",async c=>c.json(await tx(c,async db=>{
    const media=id(c.req.param("id"));const [row]=await db`select id from app.media_assets where id=${media} and post_id is not null and state='attached'`;if(!row)fail("NOT_FOUND",404);
    const [date]=await db`select *,photo_date::text as photo_date from app.attachment_photo_dates where media_id=${media}`;return {date:date||null};
  })));
  app.put("/media/:id/photo-date",async c=>{
    const media=id(c.req.param("id")),proof=await body(c,attachmentDateProof,40000);
    if(media!==proof.statement.mediaId)fail("ENVELOPE_CONTEXT");
    return c.json(await tx(c,async db=>{await writeAllowed(db);await setAttachmentDate(db,c.get("memberId"),proof,fail);return {ok:true};}));
  });
  app.get("/photo-feed",async c=>c.json(await tx(c,async db=>{
    const timezone=c.req.query("timezone")||"UTC";
    const [zone]=await db`select name from pg_timezone_names where name=${timezone}`;
    if(!zone)fail("INVALID_TIMEZONE");
    const month=c.req.query("month");if(month&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month.slice(0,4)<"0001"))fail("INVALID_MONTH");
    let cursor:{day:string;id:string;kind:string}|null=null;
    if(c.req.query("after")){try{cursor=z.object({day,id:z.string().uuid(),kind:z.enum(["photo","attachment"])}).strict().parse(JSON.parse(c.req.query("after")!));}catch{fail("INVALID_CURSOR");}}
    const rows=await db`with candidates as (
      select 'photo'::text as kind,p.id,p.photo_date as day,p.owner_id as author_id,to_jsonb(p)||jsonb_build_object('photo_date',p.photo_date::text) as photo,null::jsonb as post,null::jsonb as attachment_date
      from app.photos p
      union all
      select 'attachment'::text,m.id,coalesce(d.photo_date,(p.created_at at time zone ${timezone})::date),p.author_id,null::jsonb,to_jsonb(p),to_jsonb(d)
      from app.media_assets m join app.posts p on p.id=m.post_id left join app.attachment_photo_dates d on d.media_id=m.id
      where p.group_id is null and m.state='attached' and(app.media_deadline(m.id) is null or app.media_deadline(m.id)>statement_timestamp())
    ) select c.*,c.day::text as day,h.handle as author_handle from candidates c left join lateral app.member_handles(array[c.author_id]) h on true
    where not exists(select 1 from app.mutes where target=c.author_id)
      ${cursor?db`and(c.day,c.id,c.kind)<(${cursor.day}::date,${cursor.id}::uuid,${cursor.kind})`:db``}
      ${month?db`and c.day>=${month+"-01"}::date and c.day<(${month+"-01"}::date+interval '1 month')`:db``}
    order by c.day desc,c.id desc,c.kind desc limit 31`;
    const selected=rows.slice(0,30),ids=selected.filter(r=>r.kind==="photo").map(r=>r.id);
    const visibleGrants=ids.length?await db`select * from app.photo_grants where photo_id in ${db(ids)} order by id`:[];
    return {items:selected.map(row=>({...row,...(row.photo?{photo:{...row.photo,grants:visibleGrants.filter(g=>g.photo_id===row.id)}}:{})})),next:rows.length>30?JSON.stringify({day:selected[29].day,id:selected[29].id,kind:selected[29].kind}):null};
  })));
  app.get("/photos",async c=>c.json(await tx(c,async db=>{
    const album=c.req.query("album")?id(c.req.query("album")):null;
    const after=c.req.query("after");let cursor:{day:string;id:string}|null=null;
    if(after){try{cursor=z.object({day,id:z.string().uuid()}).strict().parse(JSON.parse(after));}catch{fail("INVALID_CURSOR");}}
    const month=c.req.query("month");if(month&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month.slice(0,4)<"0001"))fail("INVALID_MONTH");
    const rows=await db`select p.*,p.photo_date::text as photo_date from app.photos p where true
      ${album?db`and exists(select 1 from app.photo_grants g where g.photo_id=p.id and g.album_id=${album})`:db``}
      ${cursor?db`and (p.photo_date,p.id)<(${cursor.day}::date,${cursor.id}::uuid)`:db``}
      ${month?db`and p.photo_date>=${month+"-01"}::date and p.photo_date<(${month+"-01"}::date+interval '1 month')`:db``}
      order by p.photo_date desc,p.id desc limit 31`;
    const selected=rows.slice(0,30);
    const visibleGrants=selected.length?await db`select * from app.photo_grants where photo_id in ${db(selected.map(row=>row.id))} order by id`:[];
    const result=selected.map(row=>({...row,grants:visibleGrants.filter(g=>g.photo_id===row.id)}));
    return {items:result,next:rows.length>30?JSON.stringify({day:selected[29].photo_date,id:selected[29].id}):null};
  })));
  app.get("/photos/:id",async c=>c.json(await tx(c,async db=>{const photo=await requirePhoto(db,id(c.req.param("id")));return {photo:{...photo,grants:await grants(db,photo.id)}};})));
  app.post("/photos",async c=>{
    const b=await body(c,z.object({id:z.string().uuid(),photo_date:day,expires_at:z.string().datetime({offset:true}).nullable(),grants:z.array(grantSchema).min(1).max(20)}).strict(),12*1024*1024);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_epoch()`;
      for(const g of b.grants){context(g.envelope,{...b,revision:1});await checkEnvelope(db,c.get("memberId"),g.envelope,"photo");}
      await db`select app.create_photo(${b.id},${b.photo_date}::date,${b.expires_at}::timestamptz)`;
      for(const g of b.grants)await db`select app.add_photo_grant(${g.envelope.context.id},${b.id},${g.envelope.context.groupId},${db.json(g.envelope)},${g.media_id})`;
      return {id:b.id,revision:1};
    }),201);
  });
  app.post("/photos/:id/grants",async c=>{
    const photoId=id(c.req.param("id")),b=await body(c,grantSchema,600000);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_epoch()`;
      const photo=await requirePhoto(db,photoId);if(photo.owner_id!==c.get("memberId"))fail("FORBIDDEN",403);
      context(b.envelope,photo as any);await checkEnvelope(db,c.get("memberId"),b.envelope,"photo",{allowPast:true});
      await db`select app.add_photo_grant(${b.envelope.context.id},${photoId},${b.envelope.context.groupId},${db.json(b.envelope)},${b.media_id})`;
      return {id:b.envelope.context.id};
    }),201);
  });
  app.get("/photos/:id/grants/:grant/audience",async c=>c.json(await tx(c,async db=>{
    const photo=await requirePhoto(db,id(c.req.param("id"))),grant=id(c.req.param("grant"));
    if(photo.owner_id!==c.get("memberId"))fail("FORBIDDEN",403);
    const [row]=await db`select id from app.photo_grants where id=${grant} and photo_id=${photo.id}`;if(!row)fail("NOT_FOUND",404);
    return photoGrantSnapshot(db,grant);
  })));
  app.get("/photos/:id/grants/:grant/refresh-audience",async c=>c.json(await tx(c,async db=>{
    const photo=await requirePhoto(db,id(c.req.param("id"))),grant=id(c.req.param("grant"));
    const [row]=await db`select id from app.photo_grants where id=${grant} and photo_id=${photo.id}`;if(!row)fail("NOT_FOUND",404);
    return photoRefreshSnapshot(db,grant);
  })));
  app.post("/photos/:id/grants/:grant/refresh",async c=>{
    const photoId=id(c.req.param("id")),grant=id(c.req.param("grant"));
    const b=await body(c,grantSchema.extend({expected_media_id:z.string().uuid(),expected_revision:z.number().int().positive()}),600000);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_epoch()`;
      const photo=await requirePhoto(db,photoId);context(b.envelope,photo as any);
      if(b.envelope.context.id!==grant)fail("ENVELOPE_CONTEXT");
      await checkEnvelope(db,c.get("memberId"),b.envelope,"photo",{allowPast:true,photoRefreshId:grant});
      await db`select app.refresh_photo_grant(${grant},${b.expected_media_id},${b.expected_revision},${db.json(b.envelope)},${b.media_id})`;
      return {ok:true};
    }));
  });
  app.put("/photos/:id",async c=>{
    const photoId=id(c.req.param("id")),b=await body(c,z.object({photo_date:day,expected_revision:z.number().int().positive(),envelopes:z.array(envelopeSchema).min(1).max(100)}).strict(),12*1024*1024);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_epoch()`;
      const photo=await requirePhoto(db,photoId);if(photo.owner_id!==c.get("memberId"))fail("FORBIDDEN",403);
      if(photo.revision!==b.expected_revision)fail("REVISION_CHANGED",409);
      const old=await grants(db,photoId);
      if(old.length!==b.envelopes.length)fail("REVISION_CHANGED",409);
      for(const envelope of b.envelopes){
        if(!old.some(g=>g.id===envelope.context.id))fail("ENVELOPE_CONTEXT");
        context(envelope,{id:photoId,photo_date:b.photo_date,expires_at:photo.expires_at,revision:b.expected_revision+1});
        await checkEnvelope(db,c.get("memberId"),envelope,"photo",{allowPast:true,photoGrantId:envelope.context.id});
      }
      await db`select app.edit_photo(${photoId},${b.photo_date}::date,${b.expected_revision},${db.json(b.envelopes)})`;
      return {ok:true,revision:b.expected_revision+1};
    }));
  });
  app.delete("/photos/:id/grants/:grant",async c=>c.json(await tx(c,async db=>{
    const photo=id(c.req.param("id")),grant=id(c.req.param("grant"));
    const [row]=await db`select id from app.photo_grants where id=${grant} and photo_id=${photo}`;if(!row)fail("NOT_FOUND",404);
    await db`select app.remove_photo_grant(${grant})`;return {ok:true};
  })));
  app.delete("/photos/:id",async c=>c.json(await tx(c,async db=>{await db`select app.delete_photo(${id(c.req.param("id"))})`;return {ok:true};})));
}
