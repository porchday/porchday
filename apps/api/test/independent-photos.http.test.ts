import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  generateDeviceKeys,
  unlockPrivateKey,
  encryptObject,
  decryptObject,
  type ContentContext,
} from "@porchday/crypto";
import { createSocialRoutes } from "../src/social";
import { withMember } from "../src/db";
import type { Env, Variables } from "../src/types";

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
    override.audience === "album" ? `/albums/${override.groupId}/audience${change?"?"+new URLSearchParams({member_id:change.memberId,role:change.role??"remove"}):""}` : "/audiences?audience=" + (override.audience ?? "only_me"),
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
async function uploadGrant(owner:Person,photo:string,audience:ContentContext["audience"]="only_me",album:string|null=null,photoDate="2026-10-31") {
  const media=randomUUID(),grant=randomUUID();
  const encryptedMedia=await seal(owner,{bytes:"aGVsbG8=",mime:"image/jpeg",id:media},1,{id:media,kind:"media",parentId:photo,audience,groupId:album});
  const encoded=new TextEncoder().encode(JSON.stringify(encryptedMedia));
  const reserve=await call(owner.id,"/media","POST",{id:media,envelope:encryptedMedia,byte_size:encoded.length});
  expect(reserve.status,JSON.stringify(reserve.data)).toBe(201);
  const uploaded=await app.request(`https://local.test/media/${media}/bytes`,{method:"PUT",headers:{"x-member":owner.id,"content-type":"application/octet-stream"},body:encoded},env);
  expect(uploaded.status,await uploaded.text()).toBe(200);
  const envelope=await seal(owner,{media:[{id:media,mime:"image/jpeg",alt:"Original caption"}]},1,{id:grant,kind:"photo",parentId:photo,audience,groupId:album,photoDate});
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
      .filter((n) => n.endsWith(".sql"))
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
    const utc=await call(reader.id,"/photo-feed?month=2026-10&timezone=UTC");expect(utc.data.items.map((e:any)=>e.kind)).toEqual(["photo"]);
    expect((await call(outsider.id,"/photo-feed")).data.items).toHaveLength(0);
    await db`insert into app.mutes(actor,target) values(${reader.id},${owner.id})`;
    expect((await call(reader.id,"/photo-feed")).data.items).toHaveLength(0);
    expect((await call(reader.id,"/photo-feed?timezone=not-a-zone")).status).toBe(400);
    expect((await call(reader.id,"/photo-feed?after=invalid")).status).toBe(400);
  });
  it("paginates same-day photos without duplicates or missing records",async()=>{
    const owner=await person(),ids=[];
    for(let i=0;i<31;i++){if(i%10===0)await db`delete from app.social_rate_limits where member_id=${owner.id}`;ids.push((await publish(owner)).id);}
    const first=await call(owner.id,"/photo-feed?timezone=UTC");expect(first.status).toBe(200);expect(first.data.items).toHaveLength(30);expect(first.data.next).toBeTruthy();
    const second=await call(owner.id,"/photo-feed?timezone=UTC&after="+encodeURIComponent(first.data.next));expect(second.data.items).toHaveLength(1);expect(second.data.next).toBeNull();
    const actual=[...first.data.items,...second.data.items].map((e:any)=>e.id);expect(new Set(actual).size).toBe(31);expect(actual.sort()).toEqual(ids.sort());
  },15000);
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
