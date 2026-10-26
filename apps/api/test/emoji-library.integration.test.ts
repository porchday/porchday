import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import postgres,{type Sql} from 'postgres';
import {Hono} from 'hono';
import {randomUUID} from 'node:crypto';
import {generateDeviceKeys,unlockPrivateKey,encryptObject,decryptObject,type ContentContext} from '@porchday/crypto';
import {createSocialRoutes} from '../src/social';
import {withMember} from '../src/db';
import type {Env,Variables} from '../src/types';

const base=process.env.TEST_DATABASE_URL,suite=base?describe:describe.skip;
let admin:Sql,db:Sql,name:string,role:string,env:Env;
const app=new Hono<{Bindings:Env;Variables:Variables}>();
app.use('*',async(c,next)=>{c.set('memberId',c.req.header('x-member')!);c.set('authTime',Date.now());await next();});
app.route('/',createSocialRoutes());
async function call(member:string,path:string,method='GET',body?:unknown){
  const response=await app.request('https://local.test'+path,{method,headers:{'x-member':member,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},env);
  return {status:response.status,data:await response.json() as any};
}
async function person(){
  const id=randomUUID(),deviceId=randomUUID(),keys=await generateDeviceKeys(id,deviceId);
  await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  await db`insert into app.profiles(member_id,handle) values(${id},${'e_'+id.replaceAll('-','').slice(0,20)})`;
  await db`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${deviceId},${id},${keys.publicKey},${keys.fingerprint},'{"type":"initial"}'::jsonb)`;
  return {id,deviceId,keys,key:await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret)};
}
async function seal(p:Awaited<ReturnType<typeof person>>,payload:unknown,revision=1,override:Partial<ContentContext>={}){
  const {data:snapshot}=await call(p.id,'/audiences?audience=only_me');
  return encryptObject({payload,signingKey:p.key,context:{id:p.id,kind:'profile',authorId:p.id,authorDeviceId:p.deviceId,audience:'only_me',parentId:null,groupId:null,epoch:snapshot.epoch,createdAt:new Date().toISOString(),expiresAt:null,revision,...override},recipients:snapshot.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
}
suite('Owner-only encrypted emoji collection',()=>{
  beforeAll(async()=>{
    const url=new URL(base!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Disposable loopback database required');
    admin=postgres(base!,{max:1,prepare:false,onnotice:()=>{}});name='porchday_emoji_test_'+randomUUID().replaceAll('-','');role='emoji_test_'+randomUUID().replaceAll('-','');
    await admin.unsafe('CREATE DATABASE '+name);url.pathname='/'+name;db=postgres(url.href,{max:1,prepare:false,onnotice:()=>{}});
    for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.unsafe(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
    await admin.unsafe('CREATE ROLE '+role+" LOGIN PASSWORD 'synthetic-emoji-local' IN ROLE porchday_social");url.username=role;url.password='synthetic-emoji-local';
    env={HYPERDRIVE_SOCIAL:{connectionString:url.href}} as Env;
  },60000);
  afterAll(async()=>{if(db)await db.end();if(admin){if(name)await admin.unsafe('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');if(role)await admin.unsafe('DROP ROLE IF EXISTS '+role);await admin.end();}});
  it('keeps the collection encrypted, owner-only and separate from the profile; preserves CAS across concurrent writes',async()=>{
    const a=await person(),b=await person(),payload={customEmojis:[],marker:'synthetic encrypted collection'};
    expect((await call(a.id,'/emoji-library')).data).toEqual({envelope:null,revision:0});
    const envelope=await seal(a,payload);
    expect((await call(a.id,'/emoji-library','PUT',{envelope})).status).toBe(200);
    const found=await call(a.id,'/emoji-library');expect(found.data.revision).toBe(1);
    expect(await decryptObject({envelope:found.data.envelope,expectedContext:envelope.context,privateKey:a.key,authorPublicKey:a.keys.publicKey})).toEqual(payload);
    await expect(decryptObject({envelope,expectedContext:envelope.context,privateKey:b.key,authorPublicKey:a.keys.publicKey})).rejects.toThrow();
    expect((await call(b.id,'/emoji-library')).data).toEqual({envelope:null,revision:0});
    expect(await withMember(env,b.id,tx=>tx`select member_id from app.emoji_libraries`)).toHaveLength(0);
    expect((await withMember(env,b.id,tx=>tx`update app.emoji_libraries set revision=2 where member_id=${a.id}`)).count).toBe(0);
    expect(await withMember(env,a.id,tx=>tx`select member_id from app.emoji_libraries`)).toHaveLength(1);
    expect((await call(b.id,'/emoji-library','PUT',{envelope})).status).toBe(400);
    expect((await db`select envelope from app.profiles where member_id=${a.id}`)[0].envelope).toBeNull();
    const concurrent=await Promise.all([seal(a,{customEmojis:[],marker:'one'},2),seal(a,{customEmojis:[],marker:'two'},2)]);
    const results=await Promise.all(concurrent.map(envelope=>call(a.id,'/emoji-library','PUT',{envelope})));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await call(a.id,'/emoji-library')).data.revision).toBe(2);
    expect((await call(a.id,'/emoji-library','PUT',{envelope:await seal(a,payload,3,{audience:'connections'})})).status).toBe(400);
    expect((await call(a.id,'/emoji-library','PUT',{envelope:await seal(a,payload,3,{parentId:randomUUID()})})).status).toBe(400);
  });
  it('exports the owner collection with revision validation and invalidates exports when an image is removed',async()=>{
    const p=await person();const envelope=await seal(p,{customEmojis:[]});
    expect((await call(p.id,'/emoji-library','PUT',{envelope})).status).toBe(200);
    const job=await call(p.id,'/exports','POST');expect(job.data.sections).toContain('emoji_library');
    const page=await call(p.id,`/exports/${job.data.id}?section=emoji_library`);
    expect(page.data.emoji_library.envelope).toEqual(envelope);
    const refs={items:[{kind:'emoji_library',id:p.id,revision:1,expires_at:null}]};
    expect((await call(p.id,`/exports/${job.data.id}/validate`,'POST',refs)).status).toBe(200);
    expect((await call(p.id,'/emoji-library','PUT',{envelope:await seal(p,{customEmojis:[]},2)})).status).toBe(200);
    expect((await call(p.id,`/exports/${job.data.id}/validate`,'POST',refs)).status).toBe(409);
    const blocked=await seal(p,{customEmojis:[]},3);
    await db`update app.members set status='suspended' where id=${p.id}`;
    expect((await call(p.id,'/emoji-library')).data.revision).toBe(2);
    expect((await call(p.id,'/exports','POST')).status).toBe(201);
    expect((await call(p.id,'/emoji-library','PUT',{envelope:blocked})).status).not.toBe(200);
  });
  it('requires separate integration consent and returns only the grant owner collection',async()=>{
    const a=await person(),b=await person(),client=randomUUID();
    const own=await seal(a,{customEmojis:[]}),other=await seal(b,{customEmojis:[]});
    await call(a.id,'/emoji-library','PUT',{envelope:own});await call(b.id,'/emoji-library','PUT',{envelope:other});
    await db`insert into app.integration_clients(id,member_id,name,redirect_uri) values(${client},${a.id},'Synthetic emoji adapter','https://example.test/callback')`;
    for(const [scope,hash] of [['profile:read','a'.repeat(64)],['emoji:read','b'.repeat(64)]])await db`insert into app.integration_grants(id,member_id,client_id,scopes,code_challenge,code_expires_at,access_hash,access_expires_at,expires_at) values(${randomUUID()},${a.id},${client},${[scope]},'synthetic',now()+interval '10 minutes',${hash},now()+interval '10 minutes',now()+interval '1 day')`;
    await expect(db`select app.integration_page(${'a'.repeat(64)},'profile:read','emoji_library')`).rejects.toThrow('INVALID_GRANT');
    await expect(db`select app.integration_page(${'a'.repeat(64)},'emoji:read','emoji_library')`).rejects.toThrow('INVALID_GRANT');
    const [allowed]=await db`select app.integration_page(${'b'.repeat(64)},'emoji:read','emoji_library') as page`;
    expect(allowed.page.emoji_library.member_id).toBe(a.id);
    expect(allowed.page.emoji_library.envelope).toEqual(own);
    await expect(db`select app.integration_page(${'b'.repeat(64)},'emoji:read','profile')`).rejects.toThrow('INVALID_GRANT');
  });
  it('journals removals, drops stale ciphertext on restore, preserves the revision floor, and cascades account deletion',async()=>{
    const p=await person(),old=await seal(p,{customEmojis:[]});
    await call(p.id,'/emoji-library','PUT',{envelope:old});
    await call(p.id,'/emoji-library','PUT',{envelope:await seal(p,{customEmojis:[]},2)});
    const [event]=await db`select sequence::text,id,occurred_at,decision from app.safety_journal where decision->>'kind'='emoji_libraries' and decision->>'id'=${p.id} order by sequence desc limit 1`;
    expect(event.decision).toMatchObject({action:'revision',kind:'emoji_libraries',revision:2});
    await db.begin(async tx=>{await tx`select set_config('app.restore_replay','on',true)`;await tx`update app.emoji_libraries set envelope=${tx.json(old)},revision=1 where member_id=${p.id}`;});
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json([{...event,occurred_at:new Date(event.occurred_at).toISOString()}])})`;
    expect((await call(p.id,'/emoji-library')).data).toEqual({envelope:null,revision:2});
    await db`delete from app.emoji_libraries where member_id=${p.id}`;
    await db`select app.replay_safety_batch(${db.json([{...event,occurred_at:new Date(event.occurred_at).toISOString()}])})`;
    expect((await call(p.id,'/emoji-library')).data).toEqual({envelope:null,revision:2});
    expect((await call(p.id,'/emoji-library','PUT',{envelope:old})).status).toBe(409);
    expect((await call(p.id,'/emoji-library','PUT',{envelope:await seal(p,{customEmojis:[]},3)})).status).toBe(200);
    await db`delete from app.members where id=${p.id}`;
    expect(await db`select member_id from app.emoji_libraries where member_id=${p.id}`).toHaveLength(0);
  });
  it('bounds distinct reactions without breaking idempotent PUTs or inherited deletion on comments',async()=>{
    const p=await person(),postId=randomUUID(),commentId=randomUUID();
    const post=await seal(p,{text:'Synthetic reaction limits'},1,{id:postId,kind:'post'});
    expect((await call(p.id,'/posts','POST',{envelope:post})).status).toBe(201);
    const comment=await seal(p,{text:'Synthetic comment'},1,{id:commentId,kind:'comment',parentId:postId});
    expect((await call(p.id,`/posts/${postId}/comments`,'POST',{envelope:comment,parent_expires_at:null})).status).toBe(201);
    for(const [kind,target] of [['posts',postId],['comments',commentId]]){
      let first:any;
      for(let n=0;n<21;n++){
        const tag='synthetic_tag_'+String(n).padStart(4,'0');
        const envelope=await seal(p,{emoji:'like'},1,{id:tag,kind:'reaction',parentId:target});
        if(n===0)first={envelope};
        const result=await call(p.id,`/${kind}/${target}/reactions/${tag}`,'PUT',{envelope});
        expect(result.status).toBe(n<20?200:409);
        if(n===20)expect(result.data.error.code).toBe('REACTION_LIMIT');
      }
      expect((await call(p.id,`/${kind}/${target}/reactions/synthetic_tag_0000`,'PUT',first)).status).toBe(200);
    }
    expect((await call(p.id,`/posts/${postId}`,'DELETE')).status).toBe(200);
    expect(await db`select * from app.post_reactions where post_id=${postId}`).toHaveLength(0);
    expect(await db`select * from app.comment_reactions where comment_id=${commentId}`).toHaveLength(0);
  });
  it('bounds aggregate encrypted reaction bytes across a whole thread',async()=>{
    const p=await person(),id=randomUUID();
    expect((await call(p.id,'/posts','POST',{envelope:await seal(p,{},1,{id,kind:'post'})})).status).toBe(201);
    // Direct owner SQL exercises the trigger independently of HTTP byte limits.
    for(let n=0;n<5;n++)await db`insert into app.post_reactions(post_id,member_id,reaction_tag,envelope) values(${id},${p.id},${'budget_fixture_'+n},${db.json({ciphertext:'x'.repeat(3_000_000)})})`;
    await expect(db`insert into app.post_reactions(post_id,member_id,reaction_tag,envelope) values(${id},${p.id},'budget_fixture_6',${db.json({ciphertext:'x'.repeat(3_000_000)})})`).rejects.toThrow('REACTION_STORAGE_LIMIT');
  });
});
