import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import postgres,{type Sql} from 'postgres';
import {feedReadBatch} from '../src/social-feed-read';
import {nativePushRequest} from '../src/social-native-push';
import {feedPushMetadata,feedPushBody} from '../src/feed-push-payload';

describe('feed read contract',()=>{
 it('bounds and types acknowledgment batches',()=>{
  expect(feedReadBatch.safeParse({items:[{kind:'photo',id:randomUUID()}]}).success).toBe(true);
  for(const items of [[{kind:'comment',id:randomUUID()}],[{kind:'post',id:'invalid'}],Array.from({length:101},()=>({kind:'post',id:randomUUID()}))])expect(feedReadBatch.safeParse({items}).success).toBe(false);
 });
 it('limits previews to validated handles and activity type',()=>{
  const id=randomUUID(),base={kind:'feed_activity',count:1,id};
  expect(feedPushBody(feedPushMetadata({...base,author:'alice_123',content:'post'})!)).toBe('@alice_123 shared a post');
  expect(feedPushBody(feedPushMetadata({...base,author:'alice_123',content:'media'})!)).toBe('@alice_123 shared photos/videos');
  for(const extra of [{author:'alice\nFake alert',content:'post'},{author:'alice',content:'secret text'},{author:'alice',content:null}]){
   expect(feedPushBody(feedPushMetadata({...base,...extra})!)).toBe('New activity in your feed');
  }
  expect(feedPushMetadata({...base,kind:'feed_badge',author:'alice',content:'post'})).not.toHaveProperty('author');
  const config={APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_BUNDLE_ID:'org.porchday.app',APNS_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----'};
  const req=nativePushRequest({token:'ab'.repeat(32),environment:'production'},config,'test',{...base,author:'alice',content:'post',body:'private text'});
  expect(JSON.parse(req.init.body).aps.alert.body).toBe('@alice shared a post');
  expect(req.init.body).not.toContain('private text');
 });
 it('rejects untrusted badge fields and uses opaque per-publication identity',()=>{
  const id=randomUUID();expect(feedPushMetadata({kind:'feed_activity',count:3,id})).toEqual({count:3,feed:true,badgeOnly:false,tag:id.replaceAll('-','')});
  expect(feedPushMetadata({kind:'feed_activity',count:-1,id})).toBeNull();
  const config={APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_BUNDLE_ID:'org.porchday.app',APNS_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----'};
  const req=nativePushRequest({token:'ab'.repeat(32),environment:'production'},config,'test',{kind:'feed_badge',count:0,id});
  expect(JSON.parse(req.init.body)).toEqual({aps:{badge:0},destination:'feed'});
 });
});
const url=process.env.FEED_READ_TEST_DATABASE_URL;
let sql:Sql;
async function member(){const id=randomUUID(),device=randomUUID();await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;await sql`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${id},${'k'.repeat(100)},${randomUUID().replaceAll('-','')+'a'.repeat(8)},'{}')`;return {id,device};}
async function pair(){const a=await member(),b=await member();await sql`insert into app.connections(member_a,member_b,kind) values(${[a.id,b.id].sort()[0]},${[a.id,b.id].sort()[1]},'friend')`;return {a,b};}
async function publish(a:{id:string},b:{id:string;device:string},imported=false){const id=randomUUID();await sql.begin(async db=>{await db`insert into app.posts(id,author_id,audience,envelope,epoch,import_source) values(${id},${a.id},'connections','{}',1,${imported?'imported-'+id:null})`;await db`insert into app.post_recipients(post_id,member_id,device_id) values(${id},${b.id},${b.device})`;});return id;}
async function count(member:string){return sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${member},true)`;return (await db`select app.feed_unread_state() as state`)[0].state.count;});}
async function read(member:string,items:unknown[],all=false){return sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${member},true)`;return (await db`select app.mark_feed_read(${db.json(items as any)},${all}) as state`)[0].state.count;});}
(url?describe:describe.skip)('feed publication and read isolation',()=>{
 beforeAll(async()=>{if(!url||!new URL(url).pathname.endsWith('feed_read_test'))throw Error('Disposable feed_read_test database only');sql=postgres(url,{max:4,prepare:false,onnotice:()=>{}});await sql`drop schema if exists app cascade`;await sql`drop schema public cascade`;await sql`create schema public`;for(const n of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await sql.unsafe(await readFile(new URL('../migrations/'+n,import.meta.url),'utf8'));},30000);
 afterAll(async()=>{if(sql)await sql.end();});
 it('does not backfill disabled publications and records final transaction recipients once',async()=>{
  const {a,b}=await pair();await publish(a,b);expect(await count(b.id)).toBe(0);
  await sql`update app.feed_notification_config set enabled=true`;
  const post=await publish(a,b);expect(await count(b.id)).toBe(1);expect(await count(a.id)).toBe(0);
  await sql`update app.posts set envelope='{"edited":true}' where id=${post}`;expect(await count(b.id)).toBe(1);
  expect(await read(b.id,[{kind:'post',id:post}])).toBe(0);expect(await read(b.id,[{kind:'post',id:post}])).toBe(0);
 });
 it('isolates members and typed identities, then clears only currently visible items',async()=>{
  const {a,b}=await pair(),c=await member(),post=await publish(a,b);
  expect(await read(c.id,[{kind:'post',id:post}])).toBe(0);expect(await count(b.id)).toBe(1);
  expect(await read(b.id,[{kind:'photo',id:post}])).toBe(1);expect(await read(b.id,[],true)).toBe(0);
  await publish(a,b);expect(await count(b.id)).toBe(1);
 });
 it('does not notify imports or recipients added by later history catch-up',async()=>{
  const {a,b}=await pair();await publish(a,b,true);expect(await count(b.id)).toBe(0);
  const id=randomUUID();await sql`insert into app.posts(id,author_id,audience,envelope,epoch) values(${id},${a.id},'connections','{}',1)`;
  await sql`insert into app.post_recipients(post_id,member_id,device_id) values(${id},${b.id},${b.device})`;expect(await count(b.id)).toBe(0);
 });
 it('counts backdated standalone photos once and excludes adopted attachments',async()=>{
  const {a,b}=await pair();
  async function photo(adopted=false){const id=randomUUID(),media=randomUUID(),grant=randomUUID();await sql.begin(async db=>{
   await db`insert into app.photos(id,owner_id,photo_date,source_post_id,source_media_id) values(${id},${a.id},'1999-01-01',${adopted?randomUUID():null},${adopted?randomUUID():null})`;
   await db`insert into app.media_assets(id,owner_id,object_key,envelope,byte_size,state) values(${media},${a.id},${'fixture/'+media},'{}',100,'attached')`;
   await db`insert into app.photo_grants(id,photo_id,audience,envelope,media_id) values(${grant},${id},'connections',${db.json({context:{authorId:a.id,authorDeviceId:a.device}})},${media})`;
   await db`insert into app.photo_grant_recipients(grant_id,member_id) values(${grant},${b.id})`;
  });return id;}
  const id=await photo();expect(await count(b.id)).toBe(1);
  await photo(true);expect(await count(b.id)).toBe(1);
  await sql`update app.photos set photo_date='2000-01-01' where id=${id}`;expect(await count(b.id)).toBe(1);
  expect(await read(b.id,[{kind:'photo',id}])).toBe(0);
 });
 it('does not mark an uncommitted concurrent publication read',async()=>{
  const {a,b}=await pair();await publish(a,b);
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const writer=sql.begin(async db=>{const id=randomUUID();await db`insert into app.posts(id,author_id,audience,envelope,epoch) values(${id},${a.id},'connections','{}',1)`;await db`insert into app.post_recipients(post_id,member_id,device_id) values(${id},${b.id},${b.device})`;started();await hold;});
  await ready;try{expect(await read(b.id,[],true)).toBe(0);}finally{release();await writer;}
  expect(await count(b.id)).toBe(1);
 });
 it('queues one feed alert, rechecks reads before delivery, and queues a native badge clear',async()=>{
  const {a,b}=await pair(),session=randomUUID();
  await sql`insert into app.profiles(member_id,handle) values(${a.id},'preview_author')`;
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${b.id},'Synthetic feed test',${b.id+'@example.test'},true)`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${session},${b.id},${randomUUID()},now()+interval '1 day')`;
  await sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${b.id},true)`;await db`select app.register_native_push(${session},${'cd'.repeat(32)},'sandbox')`;});
  const post=await publish(a,b);
  const claimed=await sql.begin(async db=>{await db`set local role porchday_jobs`;const jobs=await db`select * from app.claim_native_push(20)`;expect(jobs).toHaveLength(1);const j=jobs[0];const [r]=await db`select app.prepare_native_push_delivery(${j.id},${j.lease}) as delivery`;expect(r.delivery.feed).toMatchObject({kind:'feed_activity',count:1,author:'preview_author',content:'post'});return j;});
  await read(b.id,[{kind:'post',id:post}]);
  await sql.begin(async db=>{await db`set local role porchday_jobs`;expect((await db`select app.prepare_native_push_delivery(${claimed.id},${claimed.lease}) as delivery`)[0].delivery).toBeNull();const jobs=await db`select * from app.claim_native_push(20)`;expect(jobs).toHaveLength(1);const j=jobs[0];const [r]=await db`select app.prepare_native_push_delivery(${j.id},${j.lease}) as delivery`;expect(r.delivery.feed).toMatchObject({kind:'feed_badge',count:0});await db`select app.finish_native_push(${j.id},${j.lease},'sent',60)`;});
  expect(await read(b.id,[{kind:'post',id:post}])).toBe(0);
  expect(await sql`select id from app.native_push_outbox where completed_at is null`).toHaveLength(0);
 });
 it('rechecks mute, block, deletion and current membership',async()=>{
  const {a,b}=await pair(),post=await publish(a,b);expect(await count(b.id)).toBe(1);
  await sql`insert into app.mutes(actor,target) values(${b.id},${a.id})`;expect(await count(b.id)).toBe(0);
  await sql`delete from app.mutes where actor=${b.id}`;expect(await count(b.id)).toBe(1);
  await sql`delete from app.connections where member_a in(${a.id},${b.id}) and member_b in(${a.id},${b.id})`;expect(await count(b.id)).toBe(0);
  await sql`delete from app.posts where id=${post}`;expect(await sql`select id from app.feed_activity where post_id=${post}`).toHaveLength(0);
 });
 it('redeems encrypted previews only while the session, audience, revision and unread state remain valid',async()=>{
  const {a,b}=await pair(),session=randomUUID(),keyId=randomUUID();
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${b.id},'Synthetic preview test',${b.id+'@example.test'},true)`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${session},${b.id},${randomUUID()},now()+interval '1 day')`;
  await sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${b.id},true)`;await db`select app.register_native_push(${session},${'ef'.repeat(32)},'sandbox')`;});
  const [subscription]=await sql`select id from app.native_push_subscriptions where member_id=${b.id}`;
  const identity={v:1,purpose:'porchday-notification-key',keyId,memberId:b.id,deviceId:b.device,publicKey:'test'};
  await sql`insert into app.notification_preview_keys(id,member_id,device_id,session_id,native_subscription,certificate) values(${keyId},${b.id},${b.device},${session},${subscription.id},${sql.json({statement:identity})})`;
  const post=await publish(a,b);
  const context={v:1,purpose:'porchday-notification-preview',kind:'post',id:post,authorId:a.id,authorDeviceId:a.device,revision:1,expiresAt:null};
  await sql`update app.posts set envelope=${sql.json({context})} where id=${post}`;
  await sql`insert into app.notification_previews(id,owner_id,post_id,revision,signed_preview) values(${post},${a.id},${post},1,${sql.json({statement:{context,recipients:[identity]},signature:'test'})})`;
  const [notice]=await sql`select id from app.notifications where recipient=${b.id} and post_id=${post} and kind='feed_activity'`;
  const [{ref}]=await sql`select app.issue_notification_preview(${notice.id},${subscription.id},true) as ref`;
  expect(ref.keyId).toBe(keyId);expect(ref.token).toMatch(/^[a-f0-9]{64}$/);
  async function redeem(token=ref.token){return sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id','00000000-0000-0000-0000-000000000000',true)`;const [r]=await db`select app.redeem_notification_preview(encode(sha256(convert_to(${token},'UTF8')),'hex')) as value`;expect((await db`select current_setting('app.member_id') as actor`)[0].actor).toBe('00000000-0000-0000-0000-000000000000');return r.value;});}
  expect((await redeem()).identity.keyId).toBe(keyId);
  expect(await redeem('ab'.repeat(32))).toBeNull();
  await sql`insert into app.mutes(actor,target) values(${b.id},${a.id})`;expect(await redeem()).toBeNull();await sql`delete from app.mutes where actor=${b.id}`;
  await sql`update public.auth_session set "expiresAt"=now()-interval '1 minute' where id=${session}`;expect(await redeem()).toBeNull();await sql`update public.auth_session set "expiresAt"=now()+interval '1 day' where id=${session}`;
  await sql`update app.device_keys set revoked_at=now() where id=${b.device}`;expect(await redeem()).toBeNull();await sql`update app.device_keys set revoked_at=null where id=${b.device}`;
  await sql`update app.posts set envelope=${sql.json({context:{...context,revision:2}})} where id=${post}`;expect(await redeem()).toBeNull();
  await sql`delete from app.notification_preview_keys where id=${keyId}`;expect(await redeem()).toBeNull();
 });

 it('checks standalone photo grant device membership before returning a preview',async()=>{
  const {a,b}=await pair(),session=randomUUID(),keyId=randomUUID(),photo=randomUUID(),media=randomUUID(),grant=randomUUID();
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${b.id},'Synthetic photo preview',${b.id+'@example.test'},true)`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${session},${b.id},${randomUUID()},now()+interval '1 day')`;
  await sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${b.id},true)`;await db`select app.register_native_push(${session},${'fa'.repeat(32)},'sandbox')`;});
  const [subscription]=await sql`select id from app.native_push_subscriptions where member_id=${b.id}`;
  const identity={keyId,memberId:b.id,deviceId:b.device};
  await sql`insert into app.notification_preview_keys(id,member_id,device_id,session_id,native_subscription,certificate) values(${keyId},${b.id},${b.device},${session},${subscription.id},${sql.json({statement:identity})})`;
  const context={v:1,purpose:'porchday-notification-preview',kind:'photo',id:photo,authorId:a.id,authorDeviceId:a.device,revision:1,expiresAt:null};
  const envelope={context:{authorId:a.id,authorDeviceId:a.device},recipients:[{memberId:b.id,deviceId:b.device}]};
  await sql.begin(async db=>{
   await db`insert into app.photos(id,owner_id,photo_date) values(${photo},${a.id},'2001-01-01')`;
   await db`insert into app.media_assets(id,owner_id,object_key,envelope,byte_size,state) values(${media},${a.id},${'fixture/'+media},'{}',100,'attached')`;
   await db`insert into app.photo_grants(id,photo_id,audience,envelope,media_id) values(${grant},${photo},'connections',${db.json(envelope)},${media})`;
   await db`insert into app.photo_grant_recipients(grant_id,member_id) values(${grant},${b.id})`;
   await db`insert into app.notification_previews(id,owner_id,photo_id,revision,signed_preview) values(${photo},${a.id},${photo},1,${db.json({statement:{context,recipients:[identity]},signature:'test'})})`;
  });
  const [notice]=await sql`select n.id from app.notifications n join app.feed_activity f on f.id=n.feed_activity_id where n.recipient=${b.id} and f.photo_id=${photo}`;
  const [{ref}]=await sql`select app.issue_notification_preview(${notice.id},${subscription.id},true) as ref`;
  async function redeem(){return sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id','00000000-0000-0000-0000-000000000000',true)`;return (await db`select app.redeem_notification_preview(encode(sha256(convert_to(${ref.token},'UTF8')),'hex')) as value`)[0].value;});}
  expect((await redeem()).context.id).toBe(photo);
  await sql`update app.photo_grants set envelope=${sql.json({...envelope,recipients:[]})} where id=${grant}`;
  expect(await redeem()).toBeNull();
 });

});
