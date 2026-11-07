import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  generateDeviceKeys,
  unlockPrivateKey,
  encryptObject,
  type ContentContext,
} from "@porchday/crypto";
import { createSocialRoutes } from "../src/social";
import {createVideoKey,encryptVideoSegment,VIDEO_CHUNK_BYTES,videoHash} from "@porchday/crypto/video";
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

async function binary(member:string,path:string,bytes:Uint8Array){return app.request('https://local.test'+path,{method:'PUT',headers:{'x-member':member,'content-type':'application/octet-stream'},body:new Blob([bytes as BlobPart])},env);}
async function draft(owner:Person,audience:ContentContext['audience']='only_me',groupId:string|null=null){
 const mediaId=randomUUID(),postId=randomUUID(),streamId=randomUUID(),key=createVideoKey(),plain=new Uint8Array([1,2,3,4]);
 const chunk=await encryptVideoSegment(key,streamId,0,plain),manifest={v:2,protocol:'porchday-video-aes256gcm-v2',streamId,key,mime:'video/mp4',size:plain.length,duration:1,width:640,height:480,chunkSize:VIDEO_CHUNK_BYTES,segments:[chunk.segment]};
 const envelope=await seal(owner,{id:mediaId,mime:'video/mp4',video:manifest},1,{id:mediaId,kind:'media',parentId:postId,audience,groupId});
 const bytes=new TextEncoder().encode(JSON.stringify(envelope)),segments=[{index:0,size:chunk.bytes.length,sha256:chunk.segment.sha256}];
 const request={id:mediaId,envelope,byte_size:bytes.length,stream_id:streamId,segments};
 return{mediaId,postId,streamId,chunk,bytes,request,audience,manifest};
}
async function upload(owner:Person,value:Awaited<ReturnType<typeof draft>>){
 expect((await call(owner.id,'/videos','POST',value.request)).status).toBe(201);
 expect((await binary(owner.id,`/videos/${value.mediaId}/chunks/0`,value.chunk.bytes)).status).toBe(200);
 expect((await call(owner.id,`/videos/${value.mediaId}/complete`,'POST',{})).status).toBe(200);
 expect((await binary(owner.id,`/media/${value.mediaId}/bytes`,value.bytes)).status).toBe(200);
}
suite("Encrypted segmented video API", () => {
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw Error("Disposable loopback database required");
    admin = postgres(base!, { max: 1, prepare: false, onnotice: () => {} });
    name = "porchday_video_http_test_" + randomUUID().replaceAll("-", "");
    role = "video_http_test_" + randomUUID().replaceAll("-", "");
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
    env = { HYPERDRIVE_SOCIAL: { connectionString: url.href }, MEDIA:bucket,VIDEO_UPLOADS_V2:"true" } as unknown as Env;
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

  it('resumes immutable chunks, refuses early publication and honors reader revocation',async()=>{
   const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);const video=await draft(owner,'connections');
   expect((await call(owner.id,'/videos','POST',video.request)).status).toBe(201);
   expect((await call(owner.id,'/videos','POST',video.request)).status).toBe(201);
   expect((await call(owner.id,'/videos','POST',{...video.request,segments:[{...video.request.segments[0],sha256:'0'.repeat(64)}]})).status).toBe(409);
   expect((await call(owner.id,`/videos/${video.mediaId}/complete`,'POST',{})).status).toBe(409);
   expect((await binary(owner.id,`/media/${video.mediaId}/bytes`,video.bytes)).status).toBe(409);
   expect((await binary(outsider.id,`/videos/${video.mediaId}/chunks/0`,video.chunk.bytes)).status).toBe(404);
   const corrupt=video.chunk.bytes.slice();corrupt[0]^=1;
   expect((await binary(owner.id,`/videos/${video.mediaId}/chunks/0`,corrupt)).status).toBe(409);
   expect((await binary(owner.id,`/videos/${video.mediaId}/chunks/0`,video.chunk.bytes)).status).toBe(200);
   expect((await binary(owner.id,`/videos/${video.mediaId}/chunks/0`,video.chunk.bytes)).status).toBe(200);
   expect((await call(owner.id,`/videos/${video.mediaId}/status`)).data.received).toEqual([0]);
   expect((await call(owner.id,`/videos/${video.mediaId}/complete`,'POST',{})).status).toBe(200);
   expect((await call(owner.id,`/videos/${video.mediaId}/complete`,'POST',{})).status).toBe(200);
   expect((await binary(owner.id,`/media/${video.mediaId}/bytes`,video.bytes)).status).toBe(200);
   const post=await seal(owner,{text:'Synthetic video',media:[{id:video.mediaId,mime:'video/mp4',videoVersion:2}]},1,{id:video.postId,kind:'post',audience:'connections'});
   expect((await call(owner.id,'/posts','POST',{envelope:post,media_ids:[video.mediaId]})).status).toBe(201);
   const read=await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':reader.id}},env);expect(read.status).toBe(200);expect(new Uint8Array(await read.arrayBuffer())).toEqual(video.chunk.bytes);
   expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':outsider.id}},env)).status).toBe(404);
   await db`delete from app.connections where member_a=${[owner.id,reader.id].sort()[0]} and member_b=${[owner.id,reader.id].sort()[1]}`;
   expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':reader.id}},env)).status).toBe(404);
  });
  it('cancels reservations idempotently and journals every private object for cleanup',async()=>{
   const owner=await person(),video=await draft(owner);await upload(owner,video);
   const chunks=await db`select object_key from app.video_chunks where stream_id=${video.streamId}`;
   expect((await call(owner.id,`/videos/${video.mediaId}`,'DELETE')).status).toBe(200);
   expect((await call(owner.id,`/videos/${video.mediaId}`,'DELETE')).status).toBe(200);
   expect(await db`select id from app.video_streams where id=${video.streamId}`).toHaveLength(0);
   expect(await db`select object_key from app.deletion_outbox where object_key=${chunks[0].object_key}`).toHaveLength(1);
   expect((await call(owner.id,'/videos','POST',video.request)).status).toBe(409);
  });
  it('backs up complete chunks and preserves expiry and orphan cleanup',async()=>{
   const owner=await person(),video=await draft(owner);await upload(owner,video);const run=randomUUID();
   await db`select app.media_backup_start_manual(${run},clock_timestamp())`;
   const chunks=await db`select object_key from app.video_chunks where stream_id=${video.streamId}`;
   expect(await db`select object_key from app.media_backup_items where run_id=${run} and object_key=${chunks[0].object_key}`).toHaveLength(1);
   await db`update app.media_assets set created_at=now()-interval '25 hours' where id=${video.mediaId}`;
   await db`select app.expire_batch(200)`;
   expect(await db`select id from app.media_assets where id=${video.mediaId}`).toHaveLength(0);
   expect(await db`select id from app.video_streams where id=${video.streamId}`).toHaveLength(0);
   expect(await db`select object_key from app.deletion_outbox where object_key=${chunks[0].object_key}`).toHaveLength(1);
  });
  it('keeps readers available when new publishing is disabled',async()=>{
   const owner=await person(),video=await draft(owner);await upload(owner,video);env.VIDEO_UPLOADS_V2='false';
   try{expect((await call(owner.id,'/videos/capabilities')).data.enabled).toBe(false);expect((await call(owner.id,'/videos','POST',video.request)).status).toBe(409);expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':owner.id}},env)).status).toBe(200);}finally{env.VIDEO_UPLOADS_V2='true';}
  });
  it('reuses completed ciphertext for history without double counting and retains it until the last grant is removed',async()=>{
   const owner=await person(),video=await draft(owner);await upload(owner,video);
   const newID=randomUUID(),parent=randomUUID(),envelope=await seal(owner,{id:newID,mime:'video/mp4',videoVersion:2,video:video.manifest},1,{id:newID,kind:'media',parentId:parent,audience:'only_me'}),packed=new TextEncoder().encode(JSON.stringify(envelope));
   const body={id:newID,envelope,byte_size:packed.length,stream_id:video.streamId};
   expect((await call(owner.id,'/videos','POST',body)).status).toBe(201);
   expect((await binary(owner.id,`/media/${newID}/bytes`,packed)).status).toBe(200);
   expect(await db`select id from app.video_streams where owner_id=${owner.id}`).toHaveLength(1);
   expect((await call(owner.id,`/videos/${video.mediaId}`,'DELETE')).status).toBe(200);
   expect((await app.request('https://local.test/videos/'+newID+'/chunks/0',{headers:{'x-member':owner.id}},env)).status).toBe(200);
   expect((await call(owner.id,`/videos/${newID}`,'DELETE')).status).toBe(200);
   expect(await db`select id from app.video_streams where owner_id=${owner.id}`).toHaveLength(0);
  });
  it('denies restored chunks recorded in the durable deletion journal',async()=>{
   const owner=await person(),video=await draft(owner);await upload(owner,video);
   const[chunk]=await db`select object_key from app.video_chunks where stream_id=${video.streamId}`;
   await db`insert into app.deletion_outbox(object_key,reason) values(${chunk.object_key},'synthetic restore replay') on conflict do nothing`;
   expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':owner.id}},env)).status).toBe(404);
  });
  it('reserves the existing member quota concurrently and frees canceled uploads',async()=>{
   expect((await call((await person()).id,'/videos/capabilities')).data).toMatchObject({direct_uploads:true,member_media_bytes:10_000_000_000,max_source_bytes:1_073_741_824,max_bytes:262_144_000,max_seconds:600});
   const owner=await person(),drafts=await Promise.all(Array.from({length:40},()=>draft(owner)));
   for(const video of drafts)video.request.segments=Array.from({length:63},(_,index)=>({index,size:(index===62?2:4)*1024*1024+16,sha256:'0'.repeat(64)}));
   const results=await Promise.all(drafts.map(video=>call(owner.id,'/videos','POST',video.request)));
   expect(results.map(r=>r.status).sort()).toEqual([...Array(38).fill(201),413,413]);
   const reserved=results.findIndex(r=>r.status===201),blocked=results.findIndex(r=>r.status===413);
   expect((await call(owner.id,`/videos/${drafts[reserved].mediaId}`,'DELETE')).status).toBe(200);
   expect((await call(owner.id,'/videos','POST',drafts[blocked].request)).status).toBe(201);
  });

  it('publishes standalone videos, grants albums access, shares one stream and preserves revocation',async()=>{
   const owner=await person(),reader=await person(),outsider=await person();await connect(owner,reader);
   const video=await draft(owner,'connections');await upload(owner,video);
   const photoDate='2026-11-01',grant=await seal(owner,{media:[{id:video.mediaId,mime:'video/mp4',videoVersion:3}]},1,{id:randomUUID(),kind:'photo',parentId:video.postId,audience:'connections',photoDate});
   const published=await call(owner.id,'/photos','POST',{id:video.postId,photo_date:photoDate,expires_at:null,grants:[{envelope:grant,media_id:video.mediaId}]});
   expect(published.status,JSON.stringify(published.data)).toBe(201);
   expect(await db`select id from app.posts where id=${video.postId}`).toHaveLength(0);
   expect((await call(reader.id,'/photos/'+video.postId)).status).toBe(200);
   expect((await call(outsider.id,'/photos/'+video.postId)).status).toBe(404);
   expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':reader.id}},env)).status).toBe(200);
   const comment=await seal(reader,{text:'Direct video comment'},1,{id:randomUUID(),kind:'comment',audience:'photo',parentId:video.postId});
   expect((await call(reader.id,`/photos/${video.postId}/interactions`,'POST',{envelope:comment})).status).toBe(201);
   const album=randomUUID(),albumEnvelope=await seal(owner,{name:'Video album'},1,{id:album,kind:'album'});
   expect((await call(owner.id,'/albums','POST',{envelope:albumEnvelope})).status).toBe(201);
   const shared=await seal(owner,{name:'Video album'},2,{...albumEnvelope.context,audience:'album',groupId:album,revision:2},{memberId:outsider.id,role:'read'});
   expect((await call(owner.id,`/albums/${album}/members/${outsider.id}`,'PUT',{role:'read',expected_revision:1,envelope:shared})).status).toBe(200);
   const mediaId=randomUUID(),envelope=await seal(owner,{video:video.manifest,mime:'video/mp4'},1,{id:mediaId,kind:'media',parentId:video.postId,audience:'album',groupId:album});
   const bytes=new TextEncoder().encode(JSON.stringify(envelope));
   expect((await call(owner.id,'/videos','POST',{id:mediaId,envelope,byte_size:bytes.length,stream_id:video.streamId})).status).toBe(201);
   expect((await binary(owner.id,`/media/${mediaId}/bytes`,bytes)).status).toBe(200);
   const albumGrant=await seal(owner,{media:[{id:mediaId,mime:'video/mp4',videoVersion:3}]},1,{id:randomUUID(),kind:'photo',parentId:video.postId,audience:'album',groupId:album,photoDate});
   const added=await call(owner.id,`/photos/${video.postId}/grants`,'POST',{envelope:albumGrant,media_id:mediaId});expect(added.status,JSON.stringify(added.data)).toBe(201);
   expect(await db`select id from app.video_streams where owner_id=${owner.id}`).toHaveLength(1);
   expect((await app.request('https://local.test/videos/'+mediaId+'/chunks/0',{headers:{'x-member':outsider.id}},env)).status).toBe(200);
   expect((await call(owner.id,`/videos/${video.mediaId}`,'DELETE')).status).toBe(409);
   await db`delete from app.album_members where album_id=${album} and member_id=${outsider.id}`;
   expect((await app.request('https://local.test/videos/'+mediaId+'/chunks/0',{headers:{'x-member':outsider.id}},env)).status).toBe(404);
   expect((await app.request('https://local.test/videos/'+video.mediaId+'/chunks/0',{headers:{'x-member':reader.id}},env)).status).toBe(200);
  });

  it('limits an album administrator to refreshing the same photo stream and keeps uploader ownership',async()=>{
   const owner=await person(),manager=await person(),reader=await person();await connect(owner,manager);await connect(owner,reader);
   const album=randomUUID(),first=await seal(owner,{name:'History'},1,{id:album,kind:'album'});
   expect((await call(owner.id,'/albums','POST',{envelope:first})).status).toBe(201);
   async function memberChange(who:Person,role:string,revision:number){const envelope=await seal(owner,{name:'History'},revision+1,{...first.context,revision:revision+1,audience:'album',groupId:album},{memberId:who.id,role});expect((await call(owner.id,`/albums/${album}/members/${who.id}`,'PUT',{envelope,role,expected_revision:revision})).status).toBe(200);}
   await memberChange(manager,'admin',1);
   const video=await draft(owner,'album',album);await upload(owner,video);
   const gid=randomUUID(),photoDate='2026-11-01',grant=await seal(owner,{media:[{id:video.mediaId,mime:'video/mp4',videoVersion:3}]},1,{id:gid,kind:'photo',parentId:video.postId,audience:'album',groupId:album,photoDate});
   const directId=randomUUID(),directEnvelope=await seal(owner,{video:video.manifest,mime:'video/mp4'},1,{id:directId,kind:'media',parentId:video.postId}),directBytes=new TextEncoder().encode(JSON.stringify(directEnvelope));
   expect((await call(owner.id,'/videos','POST',{id:directId,envelope:directEnvelope,stream_id:video.streamId,byte_size:directBytes.length})).status).toBe(201);
   expect((await binary(owner.id,`/media/${directId}/bytes`,directBytes)).status).toBe(200);
   const directGrant=await seal(owner,{media:[{id:directId,mime:'video/mp4',videoVersion:3}]},1,{id:randomUUID(),kind:'photo',parentId:video.postId,photoDate});
   const published=await call(owner.id,'/photos','POST',{id:video.postId,photo_date:photoDate,expires_at:null,grants:[{envelope:directGrant,media_id:directId},{envelope:grant,media_id:video.mediaId}]});expect(published.status,JSON.stringify(published.data)).toBe(201);
   await memberChange(reader,'read',2);
   const path=`/photos/${video.postId}/grants/${gid}`,snapshot=(await call(manager.id,path+'/refresh-audience')).data;
   async function refreshSeal(payload:unknown,context:ContentContext){return encryptObject({payload,context:{...context,authorId:manager.id,authorDeviceId:manager.deviceId,epoch:snapshot.epoch},signingKey:manager.key,recipients:snapshot.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});}
   const {photoDate:_,...context}=grant.context,media=randomUUID(),envelope=await refreshSeal({video:video.manifest,mime:'video/mp4'},{...context,id:media,kind:'media'}),bytes=new TextEncoder().encode(JSON.stringify(envelope));
   const reserve=await call(manager.id,'/videos','POST',{id:media,envelope,stream_id:video.streamId,byte_size:bytes.length,photo_refresh_id:gid});expect(reserve.status,JSON.stringify(reserve.data)).toBe(201);
   expect((await binary(manager.id,`/media/${media}/bytes`,bytes)).status).toBe(200);
   const updated=await refreshSeal({media:[{id:media,mime:'video/mp4',videoVersion:3}]},grant.context);
   const result=await call(manager.id,path+'/refresh','POST',{envelope:updated,media_id:media,expected_media_id:video.mediaId,expected_revision:1});expect(result.status,JSON.stringify(result.data)).toBe(200);
   expect(await db`select owner_id from app.media_assets where id=${media}`).toMatchObject([{owner_id:owner.id}]);
   expect(await db`select owner_id from app.video_streams where id=${video.streamId}`).toMatchObject([{owner_id:owner.id}]);
   expect((await app.request('https://local.test/videos/'+media+'/chunks/0',{headers:{'x-member':reader.id}},env)).status).toBe(200);
   // Even an administrator who can play it cannot borrow that stream for another photo.
   const borrowed=await draft(manager,'album',album);
   const bad=await call(manager.id,'/videos','POST',{...borrowed.request,segments:undefined,stream_id:video.streamId});expect(bad.status,JSON.stringify(bad.data)).toBe(404);
   await db`delete from app.members where id=${manager.id}`;
   expect((await app.request('https://local.test/videos/'+media+'/chunks/0',{headers:{'x-member':reader.id}},env)).status).toBe(200);
  });

  it('exports only through a live authorized job and requires a video-capable reader',async()=>{
   const owner=await person(),stranger=await person(),video=await draft(owner);await upload(owner,video);
   const envelope=await seal(owner,{text:'Synthetic video export',media:[{id:video.mediaId,mime:'video/mp4',videoVersion:2}]},1,{id:video.postId,kind:'post',audience:'only_me'});
   expect((await call(owner.id,'/posts','POST',{envelope,media_ids:[video.mediaId]})).status).toBe(201);
   const job=await call(owner.id,'/exports','POST',{});expect(job.status).toBe(201);
   const path=`/exports/${job.data.id}/media/${video.mediaId}`;
   expect((await call(owner.id,path+'/bytes')).status).toBe(409);
   expect((await call(owner.id,path+'/bytes?video_version=2')).status).toBe(200);
   const chunk=await app.request('https://local.test'+path+'/chunks/0',{headers:{'x-member':owner.id}},env);expect(chunk.status).toBe(200);expect(new Uint8Array(await chunk.arrayBuffer())).toEqual(video.chunk.bytes);
   expect((await app.request('https://local.test'+path+'/chunks/0',{headers:{'x-member':stranger.id}},env)).status).not.toBe(200);
   expect((await call(owner.id,'/exports/'+job.data.id,'DELETE')).status).toBe(200);
   expect((await app.request('https://local.test'+path+'/chunks/0',{headers:{'x-member':owner.id}},env)).status).not.toBe(200);
   // Old clients cannot silently publish the small update card as the video.
   const next=randomUUID(),replacement=await seal(owner,{text:'Synthetic reshare',media:[]},1,{id:next,kind:'post',audience:'only_me'});
   expect((await call(owner.id,`/posts/${video.postId}/reshare`,'POST',{envelope:replacement,media_ids:[],source_expires_at:null})).data.error.code).toBe('CLIENT_UPDATE_REQUIRED');
  });

});
