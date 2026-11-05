import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  signStatement,
  generateDeviceKeys,
  unlockPrivateKey,
  encryptObject,
  decryptObject,
  type ContentContext,
} from "@porchday/crypto";
import { createSocialRoutes } from "../src/social";
import { withMember } from "../src/db";
import type { Env, Variables } from "../src/types";

// Exercise the preserved release schema as well as the full migration chain.
const schemaProfile=process.env.PHOTO_TEST_SCHEMA;
if(schemaProfile&&schemaProfile!=="without-052-057")throw Error("Unknown photo test schema profile");
const includeMigration=(name:string)=>name.endsWith(".sql")&&!(schemaProfile==="without-052-057"&&["052_group_invitation_roster.sql","057_privacy_transaction_commits.sql"].includes(name));
const base = process.env.TEST_DATABASE_URL,
  suite = base ? describe : describe.skip;
const objects=new Map<string,{bytes:Uint8Array;etag:string}>();
const bucket={
  async put(key:string,stream:ReadableStream,options:any){if(options?.onlyIf&&objects.has(key))return null;const bytes=new Uint8Array(await new Response(stream).arrayBuffer());const etag=randomUUID();objects.set(key,{bytes,etag});return {etag};},
  async get(key:string){const object=objects.get(key);return object?{etag:object.etag,size:object.bytes.length,body:new Blob([object.bytes as BlobPart]).stream()}:null;},
  async head(key:string){const object=objects.get(key);return object?{etag:object.etag,size:object.bytes.length}:null;},
  async delete(key:string){objects.delete(key);}
};
let admin: Sql, db: Sql, name: string, role: string, env: Env;
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", async (c, next) => {
  c.set("memberId", c.req.header("x-member")!);
  c.set("authTime", Date.now());
  await next();
});
app.route("/", createSocialRoutes());
async function call(
  member: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await app.request(
    "https://local.test" + path,
    {
      method,
      headers: { "x-member": member, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
  return { status: response.status, data: (await response.json()) as any };
}
async function person() {
  const id = randomUUID(),
    deviceId = randomUUID(),
    keys = await generateDeviceKeys(id, deviceId);
  await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  await db`insert into app.profiles(member_id,handle) values(${id},${"e_" + id.replaceAll("-", "").slice(0, 20)})`;
  await db`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${deviceId},${id},${keys.publicKey},${keys.fingerprint},'{"type":"initial"}'::jsonb)`;
  return {
    id,
    deviceId,
    keys,
    key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret),
  };
}
async function seal(
  p: Awaited<ReturnType<typeof person>>,
  payload: unknown,
  revision = 1,
  override: Partial<ContentContext> = {},
  change?: {memberId:string;role:string|null},
) {
  const { data: snapshot } = await call(
    p.id,
    override.audience === "photo" ? `/photos/${override.parentId}/interactions/audience` : override.audience === "album" ? `/albums/${override.groupId}/audience${change?"?"+new URLSearchParams({member_id:change.memberId,role:change.role??"remove"}):""}` : "/audiences?audience=" + (override.audience ?? "only_me"),
  );
  return encryptObject({
    payload,
    signingKey: p.key,
    context: {
      id: p.id,
      kind: "profile",
      authorId: p.id,
      authorDeviceId: p.deviceId,
      audience: "only_me",
      parentId: null,
      groupId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revision,
      ...override,
      epoch: snapshot.epoch,
    },
    recipients: snapshot.devices.map((d: any) => ({
      memberId: d.member_id,
      deviceId: d.id,
      publicKey: d.public_key,
    })),
  });
}

type Person=Awaited<ReturnType<typeof person>>;
async function connect(a:Person,b:Person){await db`insert into app.connections(member_a,member_b,kind) values(${[a.id,b.id].sort()[0]},${[a.id,b.id].sort()[1]},'friend')`;}
async function uploadGrant(owner:Person,photo:string,audience:ContentContext["audience"]="only_me",album:string|null=null,photoDate="2026-10-31",expiresAt:string|null=null) {
  const media=randomUUID(),grant=randomUUID();
  const encryptedMedia=await seal(owner,{bytes:"aGVsbG8=",mime:"image/jpeg",id:media},1,{id:media,kind:"media",parentId:photo,audience,groupId:album,expiresAt});
  const encoded=new TextEncoder().encode(JSON.stringify(encryptedMedia));
  const reserve=await call(owner.id,"/media","POST",{id:media,envelope:encryptedMedia,byte_size:encoded.length});
  expect(reserve.status,JSON.stringify(reserve.data)).toBe(201);
  const uploaded=await app.request(`https://local.test/media/${media}/bytes`,{method:"PUT",headers:{"x-member":owner.id,"content-type":"application/octet-stream"},body:encoded},env);
  expect(uploaded.status,await uploaded.text()).toBe(200);
  const envelope=await seal(owner,{media:[{id:media,mime:"image/jpeg",alt:"Original caption"}]},1,{id:grant,kind:"photo",parentId:photo,audience,groupId:album,photoDate,expiresAt});
  return {envelope,media_id:media,encryptedMedia};
}
async function publish(owner:Person,audience:ContentContext["audience"]="only_me") {
 const id=randomUUID(),grant=await uploadGrant(owner,id,audience);
 const result=await call(owner.id,"/photos","POST",{id,photo_date:"2026-10-31",expires_at:null,grants:[{envelope:grant.envelope,media_id:grant.media_id}]});
 expect(result.status,JSON.stringify(result.data)).toBe(201);return {id,grant};
}
suite("Encrypted independent photo API",()=>{
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw Error("Disposable loopback database required");
    admin = postgres(base!, { max: 1, prepare: false, onnotice: () => {} });
    name = "porchday_photo_http_test_" + randomUUID().replaceAll("-", "");
    role = "photo_http_test_" + randomUUID().replaceAll("-", "");
    await admin.unsafe("CREATE DATABASE " + name);
    url.pathname = "/" + name;
    db = postgres(url.href, { max: 1, prepare: false, onnotice: () => {} });
    for (const file of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(includeMigration)
      .sort())
      await db.unsafe(
        await readFile(
          new URL("../migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
    await admin.unsafe(
      "CREATE ROLE " +
        role +
        " LOGIN PASSWORD 'synthetic-calendar-local' IN ROLE porchday_social",
    );
    url.username = role;
    url.password = "synthetic-calendar-local";
    env = { HYPERDRIVE_SOCIAL: { connectionString: url.href }, MEDIA:bucket } as unknown as Env;
  }, 60000);
  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      if (name)
        await admin.unsafe("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
      if (role) await admin.unsafe("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });


  it("shares encrypted photo conversations only with current readers and supports retry-safe reactions",async()=>{
    const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);
    const {id}=await publish(owner,"connections"),path=`/photos/${id}/interactions`;
    expect((await call(outsider.id,path)).status).toBe(404);
    const comment=await seal(reader,{text:"A lovely photo"},1,{id:randomUUID(),kind:"comment",audience:"photo",parentId:id});
    expect(comment.recipients.map(r=>r.memberId).sort()).toEqual([owner.id,reader.id].sort());
    expect((await call(reader.id,path,"POST",{envelope:comment})).status).toBe(201);
    expect((await call(reader.id,path,"POST",{envelope:comment})).status).toBe(201);
    const listed=await call(owner.id,path);expect(listed.data.items).toHaveLength(1);
    const decoded=await decryptObject({envelope:listed.data.items[0].envelope,privateKey:owner.key,authorPublicKey:reader.keys.publicKey,expectedContext:comment.context});
    expect(decoded).toEqual({text:"A lovely photo"});
    const wrong={...comment,context:{...comment.context,id:randomUUID(),parentId:randomUUID()}};
    expect((await call(reader.id,path,"POST",{envelope:wrong})).status).toBe(400);
    const reaction=await seal(reader,{emoji:"love"},1,{id:randomUUID(),kind:"reaction",audience:"photo",parentId:id});
    expect((await call(reader.id,path,"POST",{envelope:reaction})).status).toBe(201);
    const replacement=await seal(reader,{emoji:"celebrate"},1,{id:randomUUID(),kind:"reaction",audience:"photo",parentId:id});
    expect((await call(reader.id,path,"POST",{envelope:replacement})).status).toBe(201);
    expect((await call(reader.id,path,"POST",{envelope:reaction})).status).toBe(409);
    expect((await call(owner.id,path)).data.items.filter((r:any)=>r.kind==="reaction")).toHaveLength(1);
    const job=randomUUID();await db`insert into app.data_transfer_jobs(id,member_id,kind,state) values(${job},${reader.id},'export','complete')`;
    const exported=await withMember(env,reader.id,async sql=>sql`select app.export_page(${job},'photo_interactions','') as page`);
    expect(exported[0].page.photo_interactions).toHaveLength(2);
    expect(exported[0].page.photo_interactions.every((r:any)=>r.author_id===reader.id&&r.parent_id===id)).toBe(true);
    expect((await call(owner.id,path+"/"+comment.context.id,"DELETE")).status).toBe(200);
    const [invalidated]=await db`select state from app.data_transfer_jobs where id=${job}`;expect(invalidated.state).toBe('invalidated');
    const decisions=await db`select sequence,id,occurred_at,decision from app.safety_journal where decision->>'kind'='photo_interactions' and decision->>'id'=${comment.context.id}`;
    expect(decisions).toHaveLength(1);
    const key={id:reader.deviceId,member_id:reader.id,public_key:reader.keys.publicKey,fingerprint:reader.keys.fingerprint};
    await db`insert into app.photo_interactions(id,photo_id,author_id,kind,envelope,author_key) values(${comment.context.id},${id},${reader.id},'comment',${db.json(comment)},${db.json(key)})`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(decisions as any)})`;
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
    expect(await db`select id from app.photo_interactions where id=${comment.context.id}`).toHaveLength(0);
    expect((await call(reader.id,path,"POST",{envelope:comment})).status).toBe(409);
    await db`insert into app.blocks(actor,target) values(${owner.id},${reader.id})`;
    expect((await call(reader.id,path)).status).toBe(404);
    expect((await call(owner.id,path)).data.items).toHaveLength(0);
  });

  it("keeps one conversation across albums without redistributing old comments or revoked access",async()=>{
    const owner=await person(),friend=await person(),albumReader=await person();await connect(owner,friend);
    const {id}=await publish(owner,"connections"),path=`/photos/${id}/interactions`,album=randomUUID();
    const old=await seal(friend,{text:"Before album sharing"},1,{id:randomUUID(),kind:"comment",audience:"photo",parentId:id});
    expect((await call(friend.id,path,"POST",{envelope:old})).status).toBe(201);
    const first=await seal(owner,{name:"Album"},1,{id:album,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope:first})).status).toBe(201);
    const shared=await seal(owner,{name:"Album"},2,{...first.context,audience:"album",groupId:album,revision:2},{memberId:albumReader.id,role:"read"});
    expect((await call(owner.id,`/albums/${album}/members/${albumReader.id}`,"PUT",{role:"read",expected_revision:1,envelope:shared})).status).toBe(200);
    const grant=await uploadGrant(owner,id,"album",album);
    expect((await call(owner.id,`/photos/${id}/grants`,"POST",{envelope:grant.envelope,media_id:grant.media_id})).status).toBe(201);
    expect((await call(albumReader.id,path)).data.items).toHaveLength(0);
    const reply=await seal(albumReader,{text:"I can comment as a reader"},1,{id:randomUUID(),kind:"comment",audience:"photo",parentId:id});
    expect(reply.recipients.map(r=>r.memberId).sort()).toEqual([owner.id,friend.id,albumReader.id].sort());
    expect((await call(albumReader.id,path,"POST",{envelope:reply})).status).toBe(201);
    expect((await call(friend.id,`/devices/${albumReader.deviceId}`)).status).toBe(200);
    expect((await call(friend.id,path)).data.items.find((r:any)=>r.id===reply.context.id).author_handle).toMatch(/^e_/);
    await call(friend.id,path+"/"+reply.context.id,"DELETE");
    expect((await call(owner.id,path)).data.items).toHaveLength(2);
    const stale=await seal(albumReader,{text:"Stale audience"},1,{id:randomUUID(),kind:"comment",audience:"photo",parentId:id});
    await call(owner.id,`/photos/${id}/grants/${grant.envelope.context.id}`,"DELETE");
    expect((await call(albumReader.id,path)).status).toBe(404);
    expect((await call(albumReader.id,path,"POST",{envelope:stale})).status).toBe(404);
    expect((await call(friend.id,path)).data.items).toHaveLength(2);
    await db`update app.photos set expires_at=now()-interval '1 second' where id=${id}`;
    expect((await call(owner.id,path)).status).toBe(404);
  });

  it("pages encrypted conversations with precise creation-time cursors",async()=>{
    const owner=await person(),{id}=await publish(owner),path=`/photos/${id}/interactions`;
    for(let n=0;n<26;n++){
      const envelope=await seal(owner,{text:String(n)},1,{id:randomUUID(),kind:"comment",audience:"photo",parentId:id});
      expect((await call(owner.id,path,"POST",{envelope})).status).toBe(201);
    }
    const reaction=await seal(owner,{emoji:"love"},1,{id:randomUUID(),kind:"reaction",audience:"photo",parentId:id});
    expect((await call(owner.id,path,"POST",{envelope:reaction})).status).toBe(201);
    const first=(await call(owner.id,path)).data;expect(first.items).toHaveLength(25);expect(first.own_reaction.id).toBe(reaction.context.id);expect(first.next).toBeTruthy();
    const last=(await call(owner.id,path+"?after="+encodeURIComponent(first.next))).data;
    expect(last.items).toHaveLength(2);expect(last.next).toBeNull();
    expect(new Set([...first.items,...last.items].map((r:any)=>r.id)).size).toBe(27);
  });

  it("publishes independent encrypted photos without posts, enforcing recipient access to metadata and bytes",async()=>{
    const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);
    const {id,grant}=await publish(owner,"connections");
    expect(await db`select id from app.posts where author_id=${owner.id}`).toHaveLength(0);
    const result=await call(reader.id,`/photos/${id}`);expect(result.status).toBe(200);
    expect(result.data.photo.photo_date).toBe("2026-10-31");
    const envelope=result.data.photo.grants[0].envelope;
    expect((await decryptObject<any>({envelope,expectedContext:envelope.context,privateKey:reader.key,authorPublicKey:owner.keys.publicKey})).media[0].alt).toBe("Original caption");
    const bytes=await app.request(`https://local.test/media/${grant.media_id}/bytes`,{headers:{"x-member":reader.id}},env);
    expect(bytes.status).toBe(200);
    const encrypted=await bytes.json() as any;
    expect((await decryptObject<any>({envelope:encrypted,expectedContext:encrypted.context,privateKey:reader.key,authorPublicKey:owner.keys.publicKey})).bytes).toBe("aGVsbG8=");
    expect((await call(outsider.id,`/photos/${id}`)).status).toBe(404);
    expect((await call(outsider.id,"/photos")).data.items).toHaveLength(0);
    expect((await app.request(`https://local.test/media/${grant.media_id}/bytes`,{headers:{"x-member":outsider.id}},env)).status).toBe(404);
    await expect(decryptObject({envelope,expectedContext:envelope.context,privateKey:outsider.key,authorPublicKey:owner.keys.publicKey})).rejects.toThrow();
  });
  it("edits dates and captions without adding a new connection or changing media/post chronology",async()=>{
    const owner=await person(),reader=await person(),later=await person();await connect(owner,reader);
    const {id,grant}=await publish(owner,"connections");await connect(owner,later);
    const before=(await call(owner.id,`/photos/${id}`)).data.photo;
    const snapshot=await call(owner.id,`/photos/${id}/grants/${grant.envelope.context.id}/audience`);
    expect(snapshot.status).toBe(200);expect(snapshot.data.devices.some((d:any)=>d.member_id===later.id)).toBe(false);
    const context={...grant.envelope.context,photoDate:"2001-01-01",revision:2,epoch:snapshot.data.epoch};
    const envelope=await encryptObject({payload:{media:[{id:grant.media_id,alt:"Edited caption"}]},context,signingKey:owner.key,recipients:snapshot.data.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
    const update={photo_date:"2001-01-01",expected_revision:1,envelopes:[envelope]};
    expect((await call(reader.id,`/photos/${id}`,"PUT",update)).status).toBe(403);
    expect((await call(owner.id,`/photos/${id}`,"PUT",update)).status).toBe(200);
    const after=(await call(reader.id,`/photos/${id}`)).data.photo;
    expect(after.photo_date).toBe("2001-01-01");expect(after.created_at).toBe(before.created_at);
    expect(after.grants[0].media_id).toBe(grant.media_id);
    expect((await call(later.id,`/photos/${id}`)).status).toBe(404);
    expect((await call(owner.id,"/photos?month=2001-01")).data.items.map((p:any)=>p.id)).toContain(id);
    expect((await call(owner.id,"/photos?month=2026-10")).data.items.map((p:any)=>p.id)).not.toContain(id);
    expect((await call(owner.id,`/photos/${id}`,"PUT",update)).status).toBe(409);
    expect((await call(owner.id,`/photos/${id}`,"PUT",{...update,expected_revision:2,photo_date:"2026-02-30"})).status).toBe(400);
  });
  it("adds and removes an encrypted album path without replacing the direct path",async()=>{
    const owner=await person(),friend=await person(),albumReader=await person();await connect(owner,friend);
    const {id,grant:original}=await publish(owner,"connections"),album=randomUUID();
    const albumEnvelope=await seal(owner,{name:"Shared album"},1,{id:album,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope:albumEnvelope})).status).toBe(201);
    const shared=await seal(owner,{name:"Shared album"},2,{...albumEnvelope.context,audience:"album",groupId:album,revision:2},{memberId:albumReader.id,role:"read"});
    expect((await call(owner.id,`/albums/${album}/members/${albumReader.id}`,"PUT",{role:"read",expected_revision:1,envelope:shared})).status).toBe(200);
    const added=await uploadGrant(owner,id,"album",album);
    expect((await call(owner.id,`/photos/${id}/grants`,"POST",{envelope:added.envelope,media_id:added.media_id})).status).toBe(201);
    const card=(await call(albumReader.id,"/albums")).data.items.find((a:any)=>a.id===album);
    expect(card.photo_count).toBe(1);expect(card.cover.id).toBe(id);expect(card.cover.grants).toHaveLength(1);
    const verificationKey=await call(albumReader.id,`/devices/${owner.deviceId}`);
    expect(verificationKey.status).toBe(200);
    expect(verificationKey.data.public_key).toBe(owner.keys.publicKey);
    const readable=(await call(albumReader.id,`/photos/${id}`)).data.photo;
    expect(readable.grants).toHaveLength(1);
    expect((await decryptObject<any>({envelope:readable.grants[0].envelope,expectedContext:added.envelope.context,privateKey:albumReader.key,authorPublicKey:owner.keys.publicKey})).media[0].id).toBe(added.media_id);
    expect((await call(albumReader.id,`/photos/${id}/grants/${added.envelope.context.id}`,"DELETE")).status).toBe(403);
    expect((await call(owner.id,`/photos/${id}/grants/${added.envelope.context.id}`,"DELETE")).status).toBe(200);
    expect((await call(albumReader.id,`/photos/${id}`)).status).toBe(404);
    expect((await call(albumReader.id,`/devices/${owner.deviceId}`)).status).toBe(404);
    const emptyCard=(await call(albumReader.id,"/albums")).data.items.find((a:any)=>a.id===album);expect(emptyCard.photo_count).toBe(0);expect(emptyCard.cover).toBeNull();
    expect((await call(friend.id,`/photos/${id}`)).data.photo.grants[0].media_id).toBe(original.media_id);
    expect((await app.request(`https://local.test/media/${added.media_id}/bytes`,{headers:{"x-member":albumReader.id}},env)).status).toBe(404);
    expect((await call(owner.id,`/photos/${id}`,"DELETE")).status).toBe(200);
    expect((await call(friend.id,`/photos/${id}`)).status).toBe(404);
  });
  it("refreshes original photo history using direct consent or circle membership independently",async()=>{
    for(const audience of ["connections","community","extended_family"] as const){
      const owner=await person(),bridge=await person(),reader=await person(),future=await person();
      const circle=audience!=="connections";
      if(circle){await connect(owner,bridge);await db`update app.connections set kind_a='family',kind_b='family',history_a='future',history_b='future' where member_a=${[owner.id,bridge.id].sort()[0]} and member_b=${[owner.id,bridge.id].sort()[1]}`;}
      const p=await publish(owner,audience),gid=p.grant.envelope.context.id,path=`/photos/${p.id}/grants/${gid}`;
      await connect(circle?bridge:owner,reader);
      if(circle)await db`update app.connections set kind_a='family',kind_b='family',history_a='future',history_b='future' where member_a=${[bridge.id,reader.id].sort()[0]} and member_b=${[bridge.id,reader.id].sort()[1]}`;
      else{
        await connect(owner,future);
        await db`update app.connections set history_a='future',history_b='future' where member_a=${[owner.id,future.id].sort()[0]} and member_b=${[owner.id,future.id].sort()[1]}`;
      }
      expect((await call(reader.id,`/photos/${p.id}`)).status).toBe(404);
      const pending=await call(owner.id,"/photos/history-refresh");expect(pending.status,JSON.stringify(pending.data)).toBe(200);
      expect(pending.data.items.map((x:any)=>x.id)).toContain(p.id);
      const snapshot=await call(owner.id,path+"/refresh-audience");expect(snapshot.status,JSON.stringify(snapshot.data)).toBe(200);
      expect(snapshot.data.devices.map((d:any)=>d.member_id).sort()).toEqual([owner.id,reader.id,...(circle?[bridge.id]:[])].sort());
      const encrypt=(payload:unknown,context:ContentContext)=>encryptObject({payload,context:{...context,epoch:snapshot.data.epoch},signingKey:owner.key,recipients:snapshot.data.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
      const media=randomUUID(),{photoDate:_,...base}=p.grant.envelope.context;
      const encrypted=await encrypt({bytes:"aGVsbG8=",mime:"image/jpeg"},{...base,id:media,kind:"media"}),bytes=new TextEncoder().encode(JSON.stringify(encrypted));
      const reserve=await call(owner.id,"/media","POST",{id:media,envelope:encrypted,byte_size:bytes.length,photo_refresh_id:gid});expect(reserve.status,JSON.stringify(reserve.data)).toBe(201);
      expect((await app.request(`https://local.test/media/${media}/bytes`,{method:"PUT",headers:{"x-member":owner.id,"content-type":"application/octet-stream"},body:bytes},env)).status).toBe(200);
      const envelope=await encrypt({media:[{id:media,mime:"image/jpeg",alt:"Original caption"}]},p.grant.envelope.context);
      const refreshed=await call(owner.id,path+"/refresh","POST",{envelope,media_id:media,expected_media_id:p.grant.media_id,expected_revision:1});expect(refreshed.status,JSON.stringify(refreshed.data)).toBe(200);
      const detail=await call(reader.id,`/photos/${p.id}`);expect(detail.status).toBe(200);expect(detail.data.photo.photo_date).toBe("2026-10-31");
      expect((await decryptObject<any>({envelope:detail.data.photo.grants[0].envelope,expectedContext:envelope.context,privateKey:reader.key,authorPublicKey:owner.keys.publicKey})).media[0].id).toBe(media);
      expect((await call(future.id,`/photos/${p.id}`)).status).toBe(404);
      expect((await call(reader.id,path+"/refresh-audience")).status).toBe(403);
      expect((await call(owner.id,"/photos/history-refresh")).data.items).toEqual([]);
    }
  },90000);
  it("lets an existing admin share album history without replacing direct access or the owner identity",async()=>{
    const owner=await person(),admin=await person(),reader=await person(),friend=await person();await connect(owner,admin);await connect(owner,reader);await connect(owner,friend);
    const album=randomUUID();const first=await seal(owner,{name:"History"},1,{id:album,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope:first})).status).toBe(201);
    async function memberChange(who:Person,role:string,revision:number){
      const envelope=await seal(owner,{name:"History"},revision+1,{...first.context,revision:revision+1,audience:"album",groupId:album},{memberId:who.id,role});
      const result=await call(owner.id,`/albums/${album}/members/${who.id}`,"PUT",{envelope,role,expected_revision:revision});expect(result.status,JSON.stringify(result.data)).toBe(200);
    }
    await memberChange(admin,"admin",1);
    const p=await publish(owner,"connections"),albumGrant=await uploadGrant(owner,p.id,"album",album),gid=albumGrant.envelope.context.id;
    expect((await call(owner.id,`/photos/${p.id}/grants`,"POST",{envelope:albumGrant.envelope,media_id:albumGrant.media_id})).status).toBe(201);
    await memberChange(reader,"read",2);
    // Reader can still see its direct path, but not the older album path.
    expect((await call(reader.id,`/photos/${p.id}`)).data.photo.grants.map((g:any)=>g.id)).not.toContain(gid);
    const path=`/photos/${p.id}/grants/${gid}`;
    expect((await call(reader.id,path+"/refresh-audience")).status).toBe(404);
    const snapshot=await call(admin.id,path+"/refresh-audience");expect(snapshot.status).toBe(200);
    async function sealRefresh(payload:unknown,context:ContentContext){return encryptObject({payload,context:{...context,authorId:admin.id,authorDeviceId:admin.deviceId,epoch:snapshot.data.epoch},signingKey:admin.key,recipients:snapshot.data.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});}
    const media=randomUUID();const {photoDate:_,...base}=albumGrant.envelope.context;
    const encrypted=await sealRefresh({bytes:"aGVsbG8=",mime:"image/jpeg"},{...base,id:media,kind:"media"});
    const bytes=new TextEncoder().encode(JSON.stringify(encrypted));
    const reserve=await call(admin.id,"/media","POST",{id:media,envelope:encrypted,byte_size:bytes.length,photo_refresh_id:gid});expect(reserve.status,JSON.stringify(reserve.data)).toBe(201);
    expect((await app.request(`https://local.test/media/${media}/bytes`,{method:"PUT",headers:{"x-member":admin.id,"content-type":"application/octet-stream"},body:bytes},env)).status).toBe(200);
    const envelope=await sealRefresh({media:[{id:media,mime:"image/jpeg",alt:"Original caption"}]},albumGrant.envelope.context);
    const body={envelope,media_id:media,expected_media_id:albumGrant.media_id,expected_revision:1};
    expect((await call(admin.id,path+"/refresh","POST",{...body,expected_revision:2})).status).toBe(409);
    // A membership/key epoch change between upload and attach fails closed.
    await db`update app.directory_epoch set epoch=epoch+1 where id`;
    expect((await call(admin.id,path+"/refresh","POST",body)).data.error.code).toBe("AUDIENCE_CHANGED");
    expect(await db`select media_id from app.photo_grants where id=${gid}`).toMatchObject([{media_id:albumGrant.media_id}]);
    // Restore only this synthetic fixture's epoch to exercise the valid attach.
    await db`update app.directory_epoch set epoch=epoch-1 where id`;
    const refreshed=await call(admin.id,path+"/refresh","POST",body);expect(refreshed.status,JSON.stringify(refreshed.data)).toBe(200);
    expect((await call(admin.id,path+"/refresh","POST",body)).status).toBe(409);
    const photo=(await call(reader.id,`/photos/${p.id}`)).data.photo,grant=photo.grants.find((g:any)=>g.id===gid);
    expect(photo.owner_key.member_id).toBe(owner.id);expect(grant.author_key.member_id).toBe(admin.id);
    expect((await decryptObject<any>({envelope:grant.envelope,expectedContext:envelope.context,privateKey:reader.key,authorPublicKey:admin.keys.publicKey})).media[0].id).toBe(media);
    expect((await call(friend.id,`/photos/${p.id}`)).data.photo.grants[0].media_id).toBe(p.grant.media_id);
    expect(await db`select id from app.media_assets where id=${albumGrant.media_id}`).toHaveLength(0);
    expect(await db`select owner_id from app.media_assets where id=${media}`).toMatchObject([{owner_id:owner.id}]);
    // Retained public signing keys survive the admin leaving/deleting their account.
    await db`delete from app.members where id=${admin.id}`;
    expect((await call(reader.id,`/devices/${admin.deviceId}`)).data.public_key).toBe(admin.keys.publicKey);
    expect((await app.request(`https://local.test/media/${media}/bytes`,{headers:{"x-member":reader.id}},env)).status).toBe(200);
    expect((await call(reader.id,`/photos/${p.id}`)).data.photo.owner_id).toBe(owner.id);
  });
  it("combines attachments and independent photos in the viewer's calendar without exposing private or muted photos",async()=>{
    const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);
    const independent=await publish(owner,"connections"),postId=randomUUID(),attachment=await uploadGrant(owner,postId,"connections");
    const envelope=await seal(owner,{text:"An existing post",media:[{id:attachment.media_id,mime:"image/jpeg",alt:"Attached photo"}]},1,{id:postId,kind:"post",audience:"connections",createdAt:"2026-11-01T00:30:00.000Z"});
    // Insert a historical signed fixture; production post timestamps stay immutable.
    await db`insert into app.posts(id,author_id,audience,envelope,epoch,created_at) values(${postId},${owner.id},'connections',${db.json(envelope)},${envelope.context.epoch},${envelope.context.createdAt})`;
    for(const recipient of envelope.recipients)await db`insert into app.post_recipients(post_id,device_id,member_id) values(${postId},${recipient.deviceId},${recipient.memberId})`;
    await db`update app.media_assets set post_id=${postId},state='attached' where id=${attachment.media_id}`;
    const local=await call(reader.id,"/photo-feed?month=2026-10&timezone=America%2FLos_Angeles");
    expect(local.status,JSON.stringify(local.data)).toBe(200);
    expect(local.data.items.map((e:any)=>e.kind).sort()).toEqual(["attachment","photo"]);
    expect(local.data.items.every((e:any)=>e.day==="2026-10-31")).toBe(true);
    expect(local.data.items.find((e:any)=>e.kind==="attachment").post.id).toBe(postId);
    expect(local.data.items.find((e:any)=>e.kind==="photo").photo.id).toBe(independent.id);
    const owned=await call(owner.id,"/photo-feed?owner=me");
    expect(owned.status).toBe(200);
    expect(owned.data.items).toHaveLength(2);
    expect(owned.data.items.every((entry:any)=>entry.author_id===owner.id)).toBe(true);
    expect((await call(reader.id,"/photo-feed?owner=me")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?owner="+owner.id)).status).toBe(400);
    const mixed=await call(reader.id,"/photo-feed?content=everything&order=shared");
    expect(mixed.status,JSON.stringify(mixed.data)).toBe(200);
    expect(mixed.data.items.map((e:any)=>e.kind)).toEqual(["photo","post"]);
    expect(mixed.data.items.map((e:any)=>e.id)).toEqual([independent.id,postId]);
    expect((await call(reader.id,"/photo-feed?content=posts")).data.items.map((e:any)=>e.id)).toEqual([postId]);
    expect((await call(reader.id,"/photo-feed?content=everything&month=2026-10&timezone=America%2FLos_Angeles")).data.items).toHaveLength(2);
    expect((await call(outsider.id,"/photo-feed?content=everything")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?content=invalid")).status).toBe(400);
    expect((await call(reader.id,"/photo-feed?order=invalid")).status).toBe(400);
    const utc=await call(reader.id,"/photo-feed?month=2026-10&timezone=UTC");expect(utc.data.items.map((e:any)=>e.kind)).toEqual(["photo"]);
    expect((await call(outsider.id,"/photo-feed")).data.items).toHaveLength(0);
    await db`insert into app.mutes(actor,target) values(${reader.id},${owner.id})`;
    expect((await call(reader.id,"/photo-feed")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?content=everything")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?timezone=not-a-zone")).status).toBe(400);
    expect((await call(reader.id,"/photo-feed?after=invalid")).status).toBe(400);
  });
  it("paginates mixed publication timestamps without losing microseconds or same-ID kinds",async()=>{
    const owner=await person(),ids:string[]=[];
    // Narrow SQL fixtures exercise cursor precision independently of ciphertext validation.
    for(let i=0;i<34;i++){const id=randomUUID();ids.push(id);await db`insert into app.photos(id,owner_id,photo_date,created_at) values(${id},${owner.id},'2000-01-01',${"2026-11-01T00:00:00."+String(100+i).padStart(6,"0")+"Z"}::text::timestamptz)`;}
    const postId=randomUUID();await db`insert into app.photos(id,owner_id,photo_date,created_at) values(${postId},${owner.id},'2000-01-01','2026-11-01T00:00:00.000Z')`;
    const envelope=await seal(owner,{text:"Tie"},1,{id:postId,kind:"post",createdAt:"2026-11-01T00:00:00.000Z"});
    await db`insert into app.posts(id,author_id,audience,envelope,epoch,created_at) values(${postId},${owner.id},'only_me',${db.json(envelope)},${envelope.context.epoch},${envelope.context.createdAt})`;
    for(const r of envelope.recipients)await db`insert into app.post_recipients(post_id,device_id,member_id) values(${postId},${r.deviceId},${r.memberId})`;
    const first=await call(owner.id,"/photo-feed?content=everything&order=shared");expect(first.status,JSON.stringify(first.data)).toBe(200);expect(first.data.items).toHaveLength(30);
    const second=await call(owner.id,"/photo-feed?content=everything&order=shared&after="+encodeURIComponent(first.data.next));expect(second.status,JSON.stringify(second.data)).toBe(200);expect(second.data.items).toHaveLength(6);expect(second.data.next).toBeNull();
    const all=[...first.data.items,...second.data.items];expect(new Set(all.map((e:any)=>e.kind+e.id)).size).toBe(36);expect(all.filter((e:any)=>e.kind==="photo").map((e:any)=>e.id)).toEqual([...ids].reverse().concat(postId));expect(all.slice(-2).map((e:any)=>e.kind)).toEqual(["post","photo"]);
    expect((await call(owner.id,"/photo-feed?content=everything&order=shared&month=2000-01")).data.items.every((e:any)=>e.kind==="photo")).toBe(true);
  });
  it("adopts a post attachment into an album while preserving original readers, one calendar identity and atomic dates",async()=>{
    const owner=await person(),reader=await person(),albumReader=await person(),outsider=await person();await connect(owner,reader);
    const postId=randomUUID(),source=await uploadGrant(owner,postId,"connections");
    const original=await seal(owner,{text:"Original post",media:[{id:source.media_id,mime:"image/jpeg"}]},1,{id:postId,kind:"post",audience:"connections"});
    expect((await call(owner.id,"/posts","POST",{envelope:original,media_ids:[source.media_id]})).status).toBe(201);
    const postBefore=(await call(owner.id,"/posts/"+postId)).data.post;
    const album=randomUUID(),albumEnvelope=await seal(owner,{name:"Album"},1,{id:album,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope:albumEnvelope})).status).toBe(201);
    const shared=await seal(owner,{name:"Album"},2,{...albumEnvelope.context,audience:"album",groupId:album,revision:2},{memberId:albumReader.id,role:"read"});
    expect((await call(owner.id,`/albums/${album}/members/${albumReader.id}`,"PUT",{role:"read",expected_revision:1,envelope:shared})).status).toBe(200);
    const direct=await uploadGrant(owner,source.media_id),copy=await uploadGrant(owner,source.media_id,"album",album);
    const sourceStatement={v:1,purpose:"porchday-attachment-date",mediaId:source.media_id,postId,ownerId:owner.id,deviceId:owner.deviceId,date:"2026-10-31",revision:1};
    const attempted=await uploadGrant(reader,source.media_id);
    const outsiderDate=await signStatement({...sourceStatement,ownerId:reader.id,deviceId:reader.deviceId},reader.key);
    const denied=await call(reader.id,"/photos","POST",{id:source.media_id,photo_date:"2026-10-31",expires_at:null,source_media_id:source.media_id,source_date:outsiderDate,grants:[{envelope:attempted.envelope,media_id:attempted.media_id}]});
    expect(denied.status,JSON.stringify(denied.data)).toBe(403);
    expect(await db`select id from app.photos where id=${source.media_id}`).toHaveLength(0);
    const sourceDate=await signStatement(sourceStatement,owner.key);
    const body={id:source.media_id,photo_date:"2026-10-31",expires_at:null,source_media_id:source.media_id,source_date:sourceDate,grants:[direct,copy].map(g=>({envelope:g.envelope,media_id:g.media_id}))};
    const result=await call(owner.id,"/photos","POST",body);expect(result.status,JSON.stringify(result.data)).toBe(201);
    expect((await call(owner.id,"/posts/"+postId)).data.post).toEqual(postBefore);
    expect((await call(reader.id,"/posts/"+postId)).status).toBe(200);
    expect((await call(albumReader.id,"/posts/"+postId)).status).toBe(404);
    expect((await call(reader.id,"/photo-feed")).data.items.map((e:any)=>e.kind)).toEqual(["attachment"]);
    expect((await call(owner.id,"/photo-feed")).data.items.map((e:any)=>e.kind)).toEqual(["photo"]);
    expect((await call(albumReader.id,"/photo-feed")).data.items.map((e:any)=>e.kind)).toEqual(["photo"]);
    expect((await call(owner.id,"/photo-feed?content=everything")).data.items.map((e:any)=>e.kind)).toEqual(["post"]);
    expect((await call(reader.id,"/photo-feed?content=everything")).data.items.map((e:any)=>e.kind)).toEqual(["post"]);
    const albumActivity=(await call(albumReader.id,"/photo-feed?content=everything")).data.items;
    expect(albumActivity.map((e:any)=>e.kind)).toEqual(["photo"]);
    expect(albumActivity[0].post).toBeNull();

    expect((await call(outsider.id,"/photo-feed")).data.items).toHaveLength(0);
    const envelopes=[];
    for(const grant of [direct,copy]){
      const snapshot=(await call(owner.id,`/photos/${source.media_id}/grants/${grant.envelope.context.id}/audience`)).data;
      envelopes.push(await encryptObject({payload:{media:[{id:grant.media_id,mime:"image/jpeg"}]},context:{...grant.envelope.context,photoDate:"2001-02-03",revision:2,epoch:snapshot.epoch},signingKey:owner.key,recipients:snapshot.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))}));
    }
    const edit={photo_date:"2001-02-03",expected_revision:1,envelopes};
    expect((await call(owner.id,`/photos/${source.media_id}`,"PUT",edit)).status).toBe(400);
    expect((await call(owner.id,`/photos/${source.media_id}`)).data.photo.revision).toBe(1);
    const nextDate=await signStatement({...sourceStatement,date:"2001-02-03",revision:2},owner.key);
    const saved=await call(owner.id,`/photos/${source.media_id}`,"PUT",{...edit,source_date:nextDate});expect(saved.status,JSON.stringify(saved.data)).toBe(200);
    for(const who of [owner,reader,albumReader])expect((await call(who.id,"/photo-feed?month=2001-02")).data.items).toHaveLength(1);
    expect((await call(owner.id,`/media/${source.media_id}/photo-date`)).data.photo_id).toBe(source.media_id);
    expect((await call(reader.id,`/media/${source.media_id}/photo-date`)).data.photo_id).toBeNull();
    const unilateral=await signStatement({...sourceStatement,date:"2002-03-04",revision:3},owner.key);
    expect((await call(owner.id,`/media/${source.media_id}/photo-date`,"PUT",unilateral)).status).toBe(409);
    expect((await call(owner.id,`/photos/${source.media_id}/grants/${copy.envelope.context.id}`,"DELETE")).status).toBe(200);
    expect((await call(albumReader.id,`/photos/${source.media_id}`)).status).toBe(404);
    expect((await call(reader.id,"/posts/"+postId)).status).toBe(200);
    expect((await call(owner.id,`/photos/${source.media_id}`,"DELETE")).status).toBe(200);
    expect(await db`select id from app.media_assets where id=${source.media_id}`).toHaveLength(0);
    expect((await call(reader.id,"/posts/"+postId)).status).toBe(200);
    expect((await call(reader.id,"/photo-feed")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?content=everything")).data.items.map((e:any)=>e.kind)).toEqual(["post"]);
  });
  it("refuses adoption that extends the original post deadline and retains adopted copies after post removal",async()=>{
    const owner=await person(),postId=randomUUID(),deadline=new Date(Date.now()+3600000).toISOString(),later=new Date(Date.now()+7200000).toISOString();
    const source=await uploadGrant(owner,postId,"only_me",null,"2026-10-31",later);
    const original=await seal(owner,{media:[{id:source.media_id,mime:"image/jpeg"}]},1,{id:postId,kind:"post",expiresAt:deadline});
    expect((await call(owner.id,"/posts","POST",{envelope:original,media_ids:[source.media_id]})).status).toBe(201);
    const invalid=await uploadGrant(owner,source.media_id,"only_me",null,"2026-10-31",later);
    const statement={v:1,purpose:"porchday-attachment-date",mediaId:source.media_id,postId,ownerId:owner.id,deviceId:owner.deviceId,date:"2026-10-31",revision:1};
    const proof=await signStatement(statement,owner.key);
    const body={id:source.media_id,photo_date:"2026-10-31",expires_at:later,source_media_id:source.media_id,source_date:proof,grants:[{envelope:invalid.envelope,media_id:invalid.media_id}]};
    const rejected=await call(owner.id,"/photos","POST",body);expect(rejected.status,JSON.stringify(rejected.data)).toBe(409);expect(rejected.data.error.code).toBe("SOURCE_EXPIRY_CHANGED");
    expect(await db`select id from app.photos where id=${source.media_id}`).toHaveLength(0);
    expect(await db`select media_id from app.attachment_photo_dates where media_id=${source.media_id}`).toHaveLength(0);
    const valid=await uploadGrant(owner,source.media_id,"only_me",null,"2026-10-31",deadline);
    expect((await call(owner.id,"/photos","POST",{...body,expires_at:deadline,grants:[{envelope:valid.envelope,media_id:valid.media_id}]})).status).toBe(201);
    expect((await call(owner.id,"/posts/"+postId,"DELETE")).status).toBe(200);
    expect(await db`select id from app.media_assets where id=${source.media_id}`).toHaveLength(0);
    const retained=await call(owner.id,"/photos/"+source.media_id);expect(retained.status).toBe(200);expect(retained.data.photo.expires_at).toBe(deadline);
    expect((await app.request(`https://local.test/media/${valid.media_id}/bytes`,{headers:{"x-member":owner.id}},env)).status).toBe(200);
  });
  it("restores an imported source association with independent destination IDs and idempotent retries",async()=>{
    const owner=await person(),other=await person(),photo=await publish(owner),postId=randomUUID();
    const source=await uploadGrant(owner,postId);
    const envelope=await seal(owner,{text:"Imported post",media:[{id:source.media_id,mime:"image/jpeg"}]},1,{id:postId,kind:"post"});
    expect((await call(owner.id,"/imports","POST",{id:randomUUID(),posts:[{envelope,source_id:"source-post-"+postId,media_ids:[source.media_id]}]})).status).toBe(201);
    const proof=await signStatement({v:1,purpose:"porchday-attachment-date",mediaId:source.media_id,postId,ownerId:owner.id,deviceId:owner.deviceId,date:"2026-10-31",revision:1},owner.key);
    const body={media_id:source.media_id,source_date:proof};
    expect((await call(other.id,`/photos/${photo.id}/source`,"POST",body)).status).toBe(404);
    const first=await call(owner.id,`/photos/${photo.id}/source`,"POST",body);expect(first.status,JSON.stringify(first.data)).toBe(200);
    expect((await call(owner.id,`/photos/${photo.id}/source`,"POST",body)).status).toBe(200);
    const restored=(await call(owner.id,`/photos/${photo.id}`)).data.photo;
    expect(restored.source_media_id).toBe(source.media_id);expect(restored.source_post_id).toBe(postId);expect(restored.id).not.toBe(source.media_id);
    expect((await call(owner.id,"/photo-feed")).data.items.map((e:any)=>e.kind)).toEqual(["photo"]);
    const duplicate=await publish(owner);
    const nextProof=await signStatement({...proof.statement,revision:2},owner.key);
    expect((await call(owner.id,`/photos/${duplicate.id}/source`,"POST",{...body,source_date:nextProof})).status).toBe(409);
    expect((await call(owner.id,`/media/${source.media_id}/photo-date`)).data.date.revision).toBe(1);
    const job=await call(owner.id,"/exports","POST",{});
    const exported=(await call(owner.id,`/exports/${job.data.id}?section=photos`)).data.photos.find((p:any)=>p.id===photo.id);
    expect(exported.source_media_id).toBe(source.media_id);expect(exported.source_post_id).toBe(postId);
  });
  it("imports attachment dates atomically and exports only owned date records",async()=>{
    const owner=await person(),outsider=await person();
    const postId=randomUUID(),attachment=await uploadGrant(owner,postId,"only_me");
    const envelope=await seal(owner,{text:"Imported",media:[{id:attachment.media_id,mime:"image/jpeg"}]},1,{id:postId,kind:"post",audience:"only_me"});
    const statement={v:1,purpose:"porchday-attachment-date",mediaId:attachment.media_id,postId,ownerId:owner.id,deviceId:owner.deviceId,date:"2000-02-29",revision:1};
    const proof=await signStatement(statement,owner.key);
    const body={id:randomUUID(),posts:[{envelope,source_id:"synthetic:"+postId,media_ids:[attachment.media_id],photo_dates:[{...proof,statement:{...statement,date:"2001-02-03"}}]}]};
    expect((await call(owner.id,"/imports","POST",body)).status).toBe(400);
    expect(await db`select id from app.posts where id=${postId}`).toHaveLength(0);
    body.posts[0].photo_dates=[proof];
    expect((await call(owner.id,"/imports","POST",body)).status).toBe(201);
    expect((await call(owner.id,"/imports","POST",body)).status).toBe(201);
    expect((await call(owner.id,`/media/${attachment.media_id}/photo-date`)).data.date.photo_date).toBe("2000-02-29");
    const job=await call(owner.id,"/exports","POST",{});expect(job.status).toBe(201);
    const result=await call(owner.id,`/exports/${job.data.id}?section=attachment_dates`);
    expect(result.status).toBe(200);expect(result.data.attachment_dates.map((d:any)=>d.media_id)).toEqual([attachment.media_id]);
    const checked=await call(owner.id,`/exports/${job.data.id}/validate`,"POST",{items:[{kind:"attachment_date",id:attachment.media_id,revision:1,expires_at:null}]});
    expect(checked.status,JSON.stringify(checked.data)).toBe(200);
    const other=await call(outsider.id,"/exports","POST",{});
    expect((await call(outsider.id,`/exports/${other.data.id}?section=attachment_dates`)).data.attachment_dates).toHaveLength(0);
  });
  it("publishes and edits signed attachment dates without backdating posts or changing their recipients",async()=>{
    const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);
    const postId=randomUUID(),attachment=await uploadGrant(owner,postId,"connections");
    const envelope=await seal(owner,{text:"Now, with an older photo",media:[{id:attachment.media_id,mime:"image/jpeg",alt:"Caption"}]},1,{id:postId,kind:"post",audience:"connections"});
    const statement={v:1,purpose:"porchday-attachment-date",mediaId:attachment.media_id,postId,ownerId:owner.id,deviceId:owner.deviceId,date:"2001-02-03",revision:1};
    const proof=await signStatement(statement,owner.key),body={envelope,media_ids:[attachment.media_id],photo_dates:[proof]};
    expect((await call(owner.id,"/posts","POST",body)).status).toBe(201);
    expect((await call(owner.id,"/posts","POST",body)).status).toBe(201);
    const original=(await db`select created_at,envelope from app.posts where id=${postId}`)[0];
    const recipients=await db`select * from app.post_recipients where post_id=${postId} order by device_id`;
    const path=`/media/${attachment.media_id}/photo-date`;
    const record=(await call(reader.id,path)).data.date;expect(record.photo_date).toBe("2001-02-03");expect(record.author_key.public_key).toBe(owner.keys.publicKey);
    const calendar=await call(reader.id,"/photo-feed?month=2001-02&timezone=UTC");expect(calendar.data.items[0].id).toBe(attachment.media_id);expect(calendar.data.items[0].day).toBe("2001-02-03");
    expect((await call(outsider.id,path)).status).toBe(404);
    const updated=await signStatement({...statement,date:"1999-12-31",revision:2},owner.key);
    expect((await call(reader.id,path,"PUT",updated)).status).toBe(403);
    expect((await call(owner.id,path,"PUT",{...updated,statement:{...updated.statement,date:"1999-12-30"}})).status).toBe(400);
    expect((await call(owner.id,path,"PUT",updated)).status).toBe(200);
    expect((await call(owner.id,path,"PUT",updated)).status).toBe(409);
    expect((await call(reader.id,"/photo-feed?month=2001-02&timezone=UTC")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?month=1999-12&timezone=UTC")).data.items[0].day).toBe("1999-12-31");
    expect((await db`select created_at,envelope from app.posts where id=${postId}`)[0]).toEqual(original);
    expect(await db`select * from app.post_recipients where post_id=${postId} order by device_id`).toEqual(recipients);
    // An older backup must not resurrect the previous signed date.
    const decisions=await db`select sequence,id,occurred_at,decision from app.safety_journal where decision->>'action'='attachment_photo_date_revision' and decision->>'media'=${attachment.media_id} order by sequence`;
    await db`update app.attachment_photo_dates set photo_date='2001-02-03',revision=1,proof=${db.json(proof)} where media_id=${attachment.media_id}`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(decisions as any)})`;
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
    expect((await call(owner.id,path)).data.date).toMatchObject({photo_date:null,revision:2,proof:{}});
    const restored=await signStatement({...statement,date:"1999-12-31",revision:3},owner.key);
    expect((await call(owner.id,path,"PUT",restored)).status).toBe(200);
    await db`insert into app.blocks(actor,target) values(${owner.id},${reader.id})`;
    expect((await call(reader.id,path)).status).toBe(404);
    await db`delete from app.posts where id=${postId}`;
    expect(await db`select * from app.attachment_photo_dates where media_id=${attachment.media_id}`).toHaveLength(0);
  });
  it("paginates same-day photos without duplicates or missing records",async()=>{
    const owner=await person(),ids=[];
    for(let i=0;i<31;i++){if(i%10===0)await db`delete from app.social_rate_limits where member_id=${owner.id}`;ids.push((await publish(owner)).id);}
    const first=await call(owner.id,"/photo-feed?timezone=UTC");expect(first.status).toBe(200);expect(first.data.items).toHaveLength(30);expect(first.data.next).toBeTruthy();
    const second=await call(owner.id,"/photo-feed?timezone=UTC&after="+encodeURIComponent(first.data.next));expect(second.data.items).toHaveLength(1);expect(second.data.next).toBeNull();
    const actual=[...first.data.items,...second.data.items].map((e:any)=>e.id);expect(new Set(actual).size).toBe(31);expect(actual.sort()).toEqual(ids.sort());
  },15000);
  it("shares new posts and photos with two-hop circles while preventing historical access after path changes",async()=>{
    const owner=await person(),bridge=await person(),far=await person(),late=await person(),outsider=await person();
    await connect(owner,bridge);await connect(bridge,far);
    const community=await call(owner.id,"/audiences?audience=community");expect(community.status,JSON.stringify(community.data)).toBe(200);
    expect(community.data.devices.map((d:any)=>d.member_id).sort()).toEqual([owner.id,bridge.id,far.id].sort());
    expect((await call(owner.id,"/audiences?audience=extended_family")).data.devices.map((d:any)=>d.member_id)).toEqual([owner.id]);
    await db`update app.connections set kind_a='family',kind_b='family' where ${bridge.id} in(member_a,member_b)`;
    const family=await call(owner.id,"/audiences?audience=extended_family");expect(family.data.devices.map((d:any)=>d.member_id).sort()).toEqual([owner.id,bridge.id,far.id].sort());
    const id=randomUUID(),envelope=await seal(owner,{text:"For our extended family"},1,{id,kind:"post",audience:"extended_family"});
    expect((await call(owner.id,"/posts","POST",{envelope})).status).toBe(201);
    const photo=await publish(owner,"community");
    const feed=await call(far.id,"/feed");expect(feed.data.items.find((p:any)=>p.id===id)).toMatchObject({author_category:"extended_family"});
    expect((await call(far.id,`/photos/${photo.id}`)).status).toBe(200);
    expect((await call(outsider.id,`/photos/${photo.id}`)).status).toBe(404);
    const readable=(await call(far.id,`/posts/${id}`)).data.post;
    expect((await decryptObject<any>({envelope:readable.envelope,expectedContext:envelope.context,privateKey:far.key,authorPublicKey:owner.keys.publicKey})).text).toBe("For our extended family");
    await connect(bridge,late);
    expect((await call(late.id,`/photos/${photo.id}`)).status).toBe(404);
    expect((await call(late.id,`/posts/${id}`)).status).toBe(404);
    // Breaking one mutual-family label removes the family grant only.
    await db`update app.connections set kind_a='friend' where member_a=${[bridge.id,far.id].sort()[0]} and member_b=${[bridge.id,far.id].sort()[1]}`;
    expect((await call(far.id,`/posts/${id}`)).status).toBe(404);
    expect((await call(far.id,`/photos/${photo.id}`)).status).toBe(200);
    await db`update app.connections set kind_a='family' where member_a=${[bridge.id,far.id].sort()[0]} and member_b=${[bridge.id,far.id].sort()[1]}`;
    expect((await call(far.id,`/posts/${id}`)).status).toBe(404);
    // Blocking a bridge revokes the remaining path persistently.
    await db`insert into app.blocks(actor,target) values(${owner.id},${bridge.id})`;
    expect((await call(far.id,`/photos/${photo.id}`)).status).toBe(404);
    await db`delete from app.blocks where actor=${owner.id} and target=${bridge.id}`;
    expect((await call(far.id,`/photos/${photo.id}`)).status).toBe(404);
    expect((await call(owner.id,`/photos/${photo.id}`)).status).toBe(200);
  });
  it("keeps the original photo when removing an album or cleaning up an upload",async()=>{
    const owner=await person(),p=await publish(owner);
    expect((await call(owner.id,`/photos/${p.id}/grants/${p.grant.envelope.context.id}`,"DELETE")).status).toBe(403);
    expect((await call(owner.id,`/media/${p.grant.media_id}`,"DELETE")).status).toBe(200);
    expect((await call(owner.id,`/photos/${p.id}`)).data.photo.grants[0].media_id).toBe(p.grant.media_id);
    const a=randomUUID(),envelope=await seal(owner,{name:"Album"},1,{id:a,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope})).status).toBe(201);
    const id=randomUUID(),g=await uploadGrant(owner,id,"album",a);
    const rejected=await call(owner.id,"/photos","POST",{id,photo_date:"2026-10-31",expires_at:null,grants:[{envelope:g.envelope,media_id:g.media_id}]});
    expect(rejected.data.error.code).toBe("PHOTO_ORIGINAL_REQUIRED");
    expect(await db`select id from app.photos where id=${id}`).toHaveLength(0);
  });
  it("rolls back publication if an attachment does not belong to the photo",async()=>{
    const owner=await person(),id=randomUUID(),first=await uploadGrant(owner,id),wrong=await uploadGrant(owner,randomUUID());
    const result=await call(owner.id,"/photos","POST",{id,photo_date:"2026-10-31",expires_at:null,grants:[{envelope:first.envelope,media_id:wrong.media_id}]});
    expect(result.status).toBe(409);
    expect(await db`select id from app.photos where id=${id}`).toHaveLength(0);
    expect(await db`select state from app.media_assets where id=${first.media_id}`).toMatchObject([{state:"ready"}]);
  });
  it("rejects a signed date/body mismatch and leaves no partial photo",async()=>{
    const owner=await person(),id=randomUUID(),grant=await uploadGrant(owner,id);
    const result=await call(owner.id,"/photos","POST",{id,photo_date:"2020-01-01",expires_at:null,grants:[{envelope:grant.envelope,media_id:grant.media_id}]});
    expect(result.status).toBe(400);expect(await db`select id from app.photos where id=${id}`).toHaveLength(0);
    expect((await call(owner.id,`/photos/${id}`)).status).toBe(404);
  });
});
