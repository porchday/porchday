import type { Hono } from "hono";
import { z } from "zod";
import type { EncryptedEnvelope } from "@porchday/crypto";
import type { Db } from "./db";
import { envelopeSchema } from "./social-contract";
import type { RouteDependencies, SocialContext } from "./social-media";
import type { Env, Variables } from "./types";
export type AlbumChange = {memberId: string; role: "read" | "add" | "admin" | null};
interface Dependencies extends RouteDependencies {
  body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;
  writeAllowed(db:Db):Promise<void>;
  checkEnvelope(db:Db,member:string,e:EncryptedEnvelope,kind:string,options?:{allowPast?:boolean;albumChange?:AlbumChange}):Promise<unknown>;
}
const role = z.enum(["read","add","admin"]);
const updateBody = z.object({envelope:envelopeSchema,expected_revision:z.number().int().positive()}).strict();
export async function albumSnapshot(db:Db,album:string,change?:AlbumChange) {
  const [lock]=await db`select app.lock_epoch() as epoch`;
  const devices=await db`select * from app.album_audience_devices(${album}::uuid,${change?.memberId??null}::uuid,${change?.role??null}::text)`;
  const members=await db`select * from app.album_audience_members(${album}::uuid,${change?.memberId??null}::uuid,${change?.role??null}::text)`;
  const keyed=new Set(devices.map(d=>d.member_id));
  return {epoch:Number(lock.epoch),devices,pending_members:members.filter(m=>!keyed.has(m.member_id)).map(m=>m.member_id)};
}
export function registerAlbumRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body,fail,id,writeAllowed,checkEnvelope}:Dependencies) {
  async function requireAlbum(db:Db,album:string) {
    const [row]=await db`select *,app.album_role(id) as role from app.albums where id=${album}`;
    if(!row)fail("NOT_FOUND",404);
    return row;
  }
  function context(e:EncryptedEnvelope,album:string,creating=false) {
    const c=e.context;
    if(c.id!==album||c.parentId!==null||c.groupId!==(creating?null:album)||c.audience!==(creating?"only_me":"album")||c.expiresAt!==null)fail("ENVELOPE_CONTEXT");
  }
  app.get("/albums",async c=>c.json(await tx(c,async db=>{
    const after=c.req.query("after")?id(c.req.query("after")):null;
    const rows=await db`select *,app.album_role(id) as role from app.albums ${after?db`where id>${after}::uuid`:db``} order by id limit 31`;
    const selected=rows.slice(0,30);
    const covers=selected.length?await db`with ranked as (
      select g.album_id,to_jsonb(p)||jsonb_build_object('photo_date',p.photo_date::text,'grants',jsonb_build_array(to_jsonb(g))) as photo,
      count(*) over(partition by g.album_id) as photo_count,row_number() over(partition by g.album_id order by p.photo_date desc,p.id desc) as n
      from app.photo_grants g join app.photos p on p.id=g.photo_id where g.album_id in ${db(selected.map(row=>row.id))}
    ) select album_id,photo,photo_count from ranked where n=1`:[];
    return {items:selected.map(row=>{const cover=covers.find(c=>c.album_id===row.id);return {...row,photo_count:Number(cover?.photo_count||0),cover:cover?.photo||null};}),next:rows.length>30?rows[29].id:null};
  })));
  app.post("/albums",async c=>{
    const b=await body(c,z.object({envelope:envelopeSchema}).strict(),600000),album=id(b.envelope.context.id);
    context(b.envelope,album,true);
    if(b.envelope.context.revision!==1)fail("REVISION_CHANGED",409);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_album_directory()`;
      await checkEnvelope(db,c.get("memberId"),b.envelope,"album");
      await db`select app.create_album(${album},${db.json(b.envelope)})`;
      return {id:album,revision:1};
    }),201);
  });
  app.get("/albums/:id",async c=>c.json(await tx(c,async db=>{
    const album=await requireAlbum(db,id(c.req.param("id")));
    const members=await db`select * from app.album_member_details(${album.id})`;
    return {album,members};
  })));
  app.get("/albums/:id/audience",async c=>c.json(await tx(c,async db=>{
    const album=id(c.req.param("id"));await requireAlbum(db,album);
    const target=c.req.query("member_id"), raw=c.req.query("role");
    if(!target&&raw!==undefined)fail("INVALID_ALBUM_ROLE");
    const change=target?{memberId:id(target),role:raw==="remove"?null:role.parse(raw)}:undefined;
    return albumSnapshot(db,album,change);
  })));
  app.put("/albums/:id",async c=>{
    const album=id(c.req.param("id")),b=await body(c,updateBody,600000);context(b.envelope,album);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_album_directory()`;
      const old=await requireAlbum(db,album);
      if(old.role!=="admin")fail("FORBIDDEN",403);
      if(old.revision!==b.expected_revision||b.envelope.context.revision!==old.revision+1)fail("REVISION_CHANGED",409);
      if(old.envelope.context&&old.envelope.context.createdAt!==b.envelope.context.createdAt)fail("ENVELOPE_CONTEXT");
      await checkEnvelope(db,c.get("memberId"),b.envelope,"album",{allowPast:true});
      await db`select app.edit_album(${album},${db.json(b.envelope)},${b.expected_revision})`;
      return {ok:true,revision:b.envelope.context.revision};
    }));
  });
  app.put("/albums/:id/members/:member",async c=>{
    const album=id(c.req.param("id")),memberId=id(c.req.param("member"));
    const b=await body(c,updateBody.extend({role:role.nullable()}).strict(),600000);context(b.envelope,album);
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);await db`select app.lock_album_directory()`;
      const old=await requireAlbum(db,album);
      if(old.role!=="admin")fail("FORBIDDEN",403);
      if(old.revision!==b.expected_revision||b.envelope.context.revision!==old.revision+1)fail("REVISION_CHANGED",409);
      if(old.envelope.context&&old.envelope.context.createdAt!==b.envelope.context.createdAt)fail("ENVELOPE_CONTEXT");
      await checkEnvelope(db,c.get("memberId"),b.envelope,"album",{allowPast:true,albumChange:{memberId,role:b.role}});
      await db`select app.change_album_member(${album},${memberId},${b.role},${db.json(b.envelope)},${b.expected_revision})`;
      return {ok:true,revision:b.envelope.context.revision};
    }));
  });
  app.post("/albums/:id/leave",async c=>c.json(await tx(c,async db=>{await db`select app.leave_album(${id(c.req.param("id"))})`;return {ok:true};})));
  app.post("/albums/:id/transfer",async c=>{
    const b=await body(c,z.object({member_id:z.string().uuid()}).strict());
    return c.json(await tx(c,async db=>{await db`select app.transfer_album(${id(c.req.param("id"))},${b.member_id})`;return {ok:true};}));
  });
  app.delete("/albums/:id",async c=>c.json(await tx(c,async db=>{await db`select app.delete_album(${id(c.req.param("id"))})`;return {ok:true};})));
}
