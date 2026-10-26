import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {readdir,readFile} from 'node:fs/promises';
import postgres,{type Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {initializePrivacyJournal,readJournalControl,assertJournalReadable,beginPrivacyIntent,completePrivacyIntent,checkpointJournal,quarantineJournal,verifyJournalChain,detectStalePrivacyIntents,isPrivacyMutation,privacyMutationMiddleware,type JournalStore,type JournalDatabase,type JournalEvent} from '../src/privacy-journal';
import {replayPrivacyJournal,releasePrivacyQuarantine,reconcileDurableReceipts} from '../src/restore-journal';
import type {Env,Variables} from '../src/types';

class MemoryStore implements JournalStore {
  rows=new Map<string,{text:string;etag:string}>(); counter=0; failedPuts=false; conflicts=0;
  async get(key:string){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}
  async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
    if(this.failedPuts&&key.startsWith('batches/'))throw Error('Simulated R2 outage');
    const old=this.rows.get(key);
    if((options?.onlyIf?.etagDoesNotMatch==='*'&&old)||(options?.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==old?.etag)){this.conflicts++;return null;}
    const etag=String(++this.counter);this.rows.set(key,{text,etag});return{etag};
  }
}
class MemoryDb implements JournalDatabase {
  generation=randomUUID();events:JournalEvent[]=[];quarantined=false;
  async status(){return{generation:this.generation,sequence:String(this.events.length),quarantined:this.quarantined};}
  async page(after:string){return this.events.slice(Number(after),Number(after)+3);}
  append(){this.events.push({sequence:String(this.events.length+1),id:randomUUID(),occurred_at:new Date().toISOString(),decision:{action:'delete',kind:'posts',id:randomUUID()}});}
}
async function activate(store:MemoryStore){const r=await readJournalControl(store);await store.put('control.json',JSON.stringify({...r.value,mode:'active',reason:null}),{onlyIf:{etagMatches:r.etag}});}
describe('Independent privacy checkpoint protocol',()=>{
  it('rechecks a checkpoint that commits between parallel SQL and object snapshots',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    const get=store.get.bind(store);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
    store.get=async key=>{if(key==='control.json'&&first){first=false;await gate;}return get(key);};
    // SQL snapshots sequence 0, then another request commits and checkpoints 1
    // before the first request's strongly consistent R2 read returns.
    const reading=assertJournalReadable(store,db).then(value=>({value}),error=>({error}));
    db.append();await checkpointJournal(store,db);release();
    const result=await reading;
    expect(result).not.toHaveProperty('error');
    expect('value'in result&&result.value.value.sequence).toBe('1');
  });
  it('bounds the freshness recheck and still refuses a genuinely older database',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);db.append();await checkpointJournal(store,db);
    db.events=[];const status=db.status.bind(db),get=store.get.bind(store);let statuses=0,reads=0;
    db.status=async()=>{statuses++;return status();};store.get=async key=>{reads++;return get(key);};
    await expect(assertJournalReadable(store,db)).rejects.toThrow('DATABASE_ROLLBACK_DETECTED');
    expect(statuses).toBe(2);expect(reads).toBe(2);
    expect((await readJournalControl(store)).value.sequence).toBe('1'); // No checkpoint rewrites or catch-up fabrication.
  });
  it.each(['database quarantine','control quarantine','generation change'] as const)('does not accept %s discovered during the freshness recheck',async change=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);db.append();await checkpointJournal(store,db);
    const status=db.status.bind(db),get=store.get.bind(store);let statuses=0,reads=0;
    db.status=async()=>{const value=await status();statuses++;return {...value,sequence:statuses===1?'0':'1',quarantined:change==='database quarantine'&&statuses>1,generation:change==='generation change'&&statuses>1?randomUUID():value.generation};};
    store.get=async key=>{reads++;const object=await get(key);if(change==='control quarantine'&&reads===2&&object)return {...object,text:async()=>JSON.stringify({...JSON.parse(await object.text()),mode:'quarantine'})};return object;};
    await expect(assertJournalReadable(store,db)).rejects.toThrow(change==='generation change'?'DATABASE_ROLLBACK_DETECTED':'RESTORE_QUARANTINED');
    expect(statuses).toBe(2);expect(reads).toBe(2);
  });
  it('classifies failed reads without retrying unknown I/O or exposing provider diagnostics',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    const get=store.get.bind(store);let reads=0,statuses=0;
    store.get=async()=>{reads++;throw Error('private endpoint token=hidden');};
    await expect(assertJournalReadable(store,db)).rejects.toThrow(/^JOURNAL_STORE_READ_FAILED$/);expect(reads).toBe(1);
    store.get=async()=>({etag:'private-etag',text:async()=>{throw Error('private response body');}});
    await expect(readJournalControl(store)).rejects.toThrow(/^JOURNAL_STORE_READ_FAILED$/);
    store.get=get;db.status=async()=>{statuses++;throw Error('private SQL parameters');};
    await expect(assertJournalReadable(store,db)).rejects.toThrow(/^JOURNAL_DATABASE_READ_FAILED$/);expect(statuses).toBe(1);
  });
  it('rejects missing or malformed control and malformed SQL status without fallback',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    const original=store.rows.get('control.json')!;
    for(const text of ['private-invalid-json',JSON.stringify({...JSON.parse(original.text),sequence:'1e3'}),JSON.stringify({...JSON.parse(original.text),untrusted:'private-token'})]){
      store.rows.set('control.json',{...original,text});
      await expect(assertJournalReadable(store,db)).rejects.toThrow(/^JOURNAL_CONTROL_INVALID$/);
    }
    store.rows.delete('control.json');await expect(assertJournalReadable(store,db)).rejects.toThrow(/^JOURNAL_NOT_INITIALIZED$/);
    store.rows.set('control.json',original);db.status=async()=>null as never;
    await expect(assertJournalReadable(store,db)).rejects.toThrow(/^JOURNAL_DATABASE_STATUS_INVALID$/);
  });
  it('publishes concurrent batches with CAS and acknowledges each intent only after durable coverage',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    const intents=await Promise.all(Array.from({length:12},()=>beginPrivacyIntent(store,db)));
    await expect(assertJournalReadable(store,db)).resolves.toBeDefined(); // Live operations do not stop reads.
    for(let i=0;i<25;i++)db.append();
    await Promise.all(intents.map(intent=>completePrivacyIntent(store,db,intent)));
    const control=(await readJournalControl(store)).value;
    expect(control.sequence).toBe('25');expect(control.pending).toHaveLength(0);expect(store.conflicts).toBeGreaterThan(0);
    await quarantineJournal(store,'restore_test');const verified=await verifyJournalChain(store);
    expect(verified.batches.flat().map(e=>e.id)).toEqual(db.events.map(e=>e.id));
    expect(store.rows.size).toBeGreaterThan(25); // Immutable receipts/intents/batches remain independent.
  });
  it('leaves a failed durability tail unresolved and quarantines it without an automatic release',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    const intent=await beginPrivacyIntent(store,db);db.append();store.failedPuts=true;
    await expect(completePrivacyIntent(store,db,intent)).rejects.toThrow('R2 outage');
    expect((await readJournalControl(store)).value.pending).toHaveLength(1);
    expect(await detectStalePrivacyIntents(store,Date.parse(intent.started_at)+120001)).toBe(true);
    await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');
    store.failedPuts=false;await checkpointJournal(store,db,true);
    await expect(verifyJournalChain(store)).rejects.toThrow('UNRESOLVED_PRIVACY_INTENTS');
    expect((await readJournalControl(store)).value.mode).toBe('quarantine');
  });
  it('rejects restored rollback, missing batches, and tampered immutable bytes',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);db.append();await checkpointJournal(store,db);
    const saved=db.events;db.events=[];await expect(assertJournalReadable(store,db)).rejects.toThrow('DATABASE_ROLLBACK_DETECTED');db.events=saved;
    await quarantineJournal(store,'restore_test');const control=(await readJournalControl(store)).value;
    const row=store.rows.get(control.head!.key)!;store.rows.delete(control.head!.key);
    await expect(verifyJournalChain(store)).rejects.toThrow('JOURNAL_GAP');
    store.rows.set(control.head!.key,{...row,text:row.text+' '});await expect(verifyJournalChain(store)).rejects.toThrow('JOURNAL_HASH_MISMATCH');
  });
  it('matches actual privacy routes and excludes login, new content, reads and unknown paths',()=>{
    const id=randomUUID();
    for(const [method,path] of [['DELETE',`/api/v1/posts/${id}`],['DELETE','/api/v1/account'],['PUT',`/api/v1/comments/${id}`],['PUT','/api/v1/profiles/me'],['PUT',`/api/v1/media/${id}/attachment`],['PUT',`/api/v1/blocks/${id}`],['PUT',`/api/v1/connections/${id}/kind`],['POST','/api/v1/imports'],['POST',`/api/staff/moderation/reports/${id}/actions`]])expect(isPrivacyMutation(method,path)).toBe(true);
    for(const [method,path] of [['GET',`/api/v1/posts/${id}`],['POST','/api/auth/sign-in/email'],['POST','/api/v1/posts'],['POST',`/api/v1/posts/${id}/comments`],['DELETE','/api/nonexistent'],['POST','/api/staff/nonexistent'],['PUT',`/api/v1/media/${id}/bytes`]])expect(isPrivacyMutation(method,path)).toBe(false);
  });
  it('does not create intents for unauthenticated or unmatched requests',async()=>{
    const store=new MemoryStore();const app=new Hono<{Bindings:Env;Variables:Variables}>();
    app.use('*',privacyMutationMiddleware);app.delete('/api/v1/posts/:id',c=>c.json({error:{code:'UNAUTHORIZED'}},401));app.all('*',c=>c.json({error:{code:'NOT_FOUND'}},404));
    const env={RECOVERY_JOURNAL:store} as unknown as Env;
    expect((await app.request('https://porchday.test/api/v1/posts/'+randomUUID(),{method:'DELETE'},env)).status).toBe(401);
    expect((await app.request('https://porchday.test/api/unknown',{method:'DELETE'},env)).status).toBe(404);
    expect(store.rows.size).toBe(0);
  });
  it('quarantines stale pending operations during reads without depending on the scheduled job',async()=>{
    const store=new MemoryStore(),db=new MemoryDb();await initializePrivacyJournal(store,db);await activate(store);
    await beginPrivacyIntent(store,db);const current=await readJournalControl(store);
    current.value.pending[0].started_at=new Date(Date.now()-120001).toISOString();
    await store.put('control.json',JSON.stringify(current.value),{onlyIf:{etagMatches:current.etag}});
    await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');
    expect((await readJournalControl(store)).value.mode).toBe('quarantine');
  });
});

const url=process.env.JOURNAL_TEST_DATABASE_URL;const suite=url?describe:describe.skip;let sql:Sql;
suite('PostgreSQL restore reconciliation',()=>{
  beforeAll(async()=>{
    if(!url||!new URL(url).pathname.includes('journal_test'))throw Error('Disposable journal_test database only');
    sql=postgres(url,{prepare:false,max:4,onnotice:()=>{}});await sql`drop schema if exists app cascade`;await sql`drop schema public cascade`;await sql`create schema public`;
    for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await sql.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  },30000);
  afterAll(async()=>{if(sql)await sql.end();});
  it('journals either relationship-kind change so restore cannot revive friends-only historical access',async()=>{
    const a=randomUUID(),b=randomUUID(),device=randomUUID(),post=randomUUID();
    for(const member of [a,b])await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
    await sql`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${b},${'synthetic-public'.repeat(12)},${'b'.repeat(64)},'{}')`;
    const [low,high]=[a,b].sort();
    const [edge]=await sql`insert into app.connections(member_a,member_b,kind) values(${low},${high},'friend') returning *`;
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch) values(${post},${a},'friends','{}',1)`;
    await sql`insert into app.post_recipients(post_id,device_id,member_id) values(${post},${device},${b})`;
    const [{sequence}]=await sql`select sequence from app.safety_journal_state`;
    await sql`update app.connections set kind='family' where id=${edge.id}`;
    const decisions=await sql`select sequence,id,occurred_at,decision from app.safety_journal where sequence>${sequence} order by sequence`;
    expect(decisions.some(r=>r.decision.action==='connection'&&r.decision.a===low&&r.decision.b===high)).toBe(true);
    expect(decisions.some(r=>r.decision.action==='recipient'&&r.decision.post===post)).toBe(true);
    expect(await sql`select * from app.post_recipients where post_id=${post}`).toHaveLength(0);
    // Reconstruct the older relationship/grant inside restore quarantine, then
    // replay the real recorded safety decisions from the completed relabel.
    await sql.begin(async tx=>{
      await tx`select set_config('app.restore_replay','on',true)`;
      await tx`update app.connections set kind='friend' where id=${edge.id}`;
      await tx`insert into app.post_recipients(post_id,device_id,member_id) values(${post},${device},${b})`;
      await tx`update app.safety_journal_state set restore_quarantined=true`;
      await tx`select app.replay_safety_batch(${tx.json(decisions)})`;
      expect(await tx`select * from app.connections where id=${edge.id}`).toHaveLength(0);
      expect(await tx`select * from app.post_recipients where post_id=${post}`).toHaveLength(0);
      await tx`update app.safety_journal_state set restore_quarantined=false`;
    });
  });
  it('replays deletions and shortened deadlines into an older snapshot before it can reopen',async()=>{
    const member=randomUUID(),deleted=randomUUID(),timed=randomUUID(),child=randomUUID(),media=randomUUID();
    await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch,created_at) values(${deleted},${member},'only_me','{}',1,now()-interval '1 day'),(${timed},${member},'only_me','{}',1,now()-interval '1 day')`;
    await sql`insert into app.comments(id,post_id,author_id,envelope,created_at) values(${child},${timed},${member},'{}',now()-interval '23 hours')`;
    await sql`insert into app.media_assets(id,owner_id,post_id,object_key,envelope,byte_size,state) values(${media},${member},${deleted},${'media/'+member+'/'+media},'{}',10,'attached')`;
    const store=new MemoryStore();
    const db:JournalDatabase={async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
    await initializePrivacyJournal(store,db);await activate(store);
    const before=await db.status();const snapshot=await sql`select * from app.posts where id=${deleted}`;
    const intent=await beginPrivacyIntent(store,db);
    await sql`delete from app.posts where id=${deleted}`;
    await sql`update app.posts set expires_at=now()-interval '1 hour' where id=${timed}`;
    await completePrivacyIntent(store,db,intent);
    const [deadline]=await sql`select expires_at from app.posts where id=${timed}`;
    // Simulate restoring the relevant older snapshot rows and its journal cursor.
    await sql.begin(async tx=>{
      await tx`select set_config('app.restore_replay','on',true)`;
      await tx`delete from app.deletion_ledger where object_id in(${deleted},${media})`;
      await tx`insert into app.posts ${tx(snapshot[0])}`;
      await tx.unsafe('ALTER TABLE app.posts DISABLE TRIGGER posts_immutable');await tx`update app.posts set expires_at=null where id=${timed}`;await tx.unsafe('ALTER TABLE app.posts ENABLE TRIGGER posts_immutable');
      await tx`delete from app.safety_journal where sequence>${before.sequence}::bigint`;
      await tx`update app.safety_journal_state set sequence=${before.sequence}::bigint`;
    });
    await expect(assertJournalReadable(store,db)).rejects.toThrow('DATABASE_ROLLBACK_DETECTED');
    await quarantineJournal(store,'restore_test');const verified=await verifyJournalChain(store);
    await sql`update app.safety_journal_state set restore_quarantined=true`;
    for(const events of verified.batches)await sql`select app.replay_safety_batch(${sql.json(events)})`;
    expect(await sql`select id from app.posts where id=${deleted}`).toHaveLength(0);
    expect((await sql`select expires_at from app.posts where id=${timed}`)[0].expires_at.toISOString()).toBe(deadline.expires_at.toISOString());
    const [access]=await sql.begin(async tx=>{await tx`set local role porchday_social`;await tx`select set_config('app.member_id',${member},true)`;return tx`select app.can_comment(${child}) allowed`;});expect(access.allowed).toBe(false);
    expect(await sql`select id from app.deletion_outbox where object_key=${'media/'+member+'/'+media} and completed_at is null`).toHaveLength(1);
    await expect(sql.begin(async tx=>{await tx`set local role porchday_jobs`;await tx`select app.replay_safety_batch('[]')`;})).rejects.toMatchObject({code:'42501'});
    await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');
    await sql`update app.safety_journal_state set sequence=(select max(sequence) from app.safety_journal),restore_quarantined=false`;
  });
  it('removes stale edited ciphertext, revokes restored tokens and preserves credential holds through later active events',async()=>{
    const member=randomUUID(),post=randomUUID();const oldDate=new Date(Date.now()-86400000);
    await sql`insert into public.auth_user(id,name,email,"emailVerified",credentials_changed_at) values(${member},'Restore fixture',${member+'@example.test'},true,${oldDate})`;
    await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
    await sql`insert into app.profiles(member_id,handle,envelope) values(${member},${'m_'+member.replaceAll('-','').slice(0,20)},'{"context":{"revision":1},"ciphertext":"old encrypted profile"}')`;
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch) values(${post},${member},'only_me','{"context":{"revision":1},"ciphertext":"old encrypted post"}',1)`;
    const store=new MemoryStore();const db:JournalDatabase={async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
    await initializePrivacyJournal(store,db);await activate(store);const before=await db.status();
    const intent=await beginPrivacyIntent(store,db);
    await sql`update public.auth_user set credentials_changed_at=now() where id=${member}`;
    await sql`select app.set_security_hold(${member})`;
    await sql`update app.members set status='active' where id=${member}`;
    await sql`update app.profiles set envelope='{"context":{"revision":2},"ciphertext":"new encrypted profile"}' where member_id=${member}`;
    await sql`update app.posts set envelope='{"context":{"revision":2},"ciphertext":"new encrypted post"}' where id=${post}`;
    await completePrivacyIntent(store,db,intent);
    await quarantineJournal(store,'restore_test');
    await sql.begin(async tx=>{
      await tx`select set_config('app.restore_replay','on',true)`;
      await tx`update public.auth_user set credentials_changed_at=${oldDate} where id=${member}`;
      await tx`update app.profiles set envelope='{"context":{"revision":1},"ciphertext":"old encrypted profile"}' where member_id=${member}`;
      await tx`update app.posts set envelope='{"context":{"revision":1},"ciphertext":"old encrypted post"}' where id=${post}`;
      await tx`delete from app.safety_journal where sequence>${before.sequence}::bigint`;
      await tx`update app.safety_journal_state set sequence=${before.sequence}::bigint`;
      await tx`insert into public.auth_session(id,"userId",token,"expiresAt") values(${randomUUID()},${member},${randomUUID()},now()+interval '1 day')`;
      await tx`insert into public.auth_verification(id,identifier,value,"expiresAt") values(${randomUUID()},'restored-reset','sensitive-token-fixture',now()+interval '1 day')`;
    });
    const removed:string[]=[];const result=await replayPrivacyJournal(store,sql,async key=>{removed.push(key);});
    expect(result.heldAccounts).toBe(1);expect(result.replayed).toBeGreaterThan(3);
    expect((await sql`select status from app.members where id=${member}`)[0].status).toBe('hold');
    expect((await sql`select envelope from app.profiles where member_id=${member}`)[0].envelope).toBeNull();
    expect(await sql`select id from app.posts where id=${post}`).toHaveLength(0);
    expect(await sql`select id from public.auth_session`).toHaveLength(0);expect(await sql`select id from public.auth_verification`).toHaveLength(0);
    expect((await sql`select credentials_changed_at>${oldDate} as changed from public.auth_user where id=${member}`)[0].changed).toBe(true);
    expect((await readJournalControl(store)).value.mode).toBe('quarantine');
    await releasePrivacyQuarantine(store,sql);await expect(assertJournalReadable(store,db)).resolves.toBeDefined();
  });
  it('never acknowledges a committed deletion before its independent checkpoint succeeds',async()=>{
    const member=randomUUID(),post=randomUUID();await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch) values(${post},${member},'only_me','{}',1)`;
    const store=new MemoryStore();const db:JournalDatabase={async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
    await initializePrivacyJournal(store,db);await activate(store);store.failedPuts=true;
    const app=new Hono<{Bindings:Env;Variables:Variables}>();
    app.use('*',async(c,next)=>{c.set('memberId',member);await next();});app.use('*',privacyMutationMiddleware);
    app.delete('/api/v1/posts/:id',async c=>{await sql`delete from app.posts where id=${post}`;return c.json({ok:true});});
    const response=await app.request('https://porchday.test/api/v1/posts/'+post,{method:'DELETE'},{RECOVERY_JOURNAL:store,HYPERDRIVE_JOBS:{connectionString:url},ENVIRONMENT:'staging'} as unknown as Env);
    expect(response.status).toBe(503);expect((await response.json() as any).error.code).toBe('PRIVACY_CHECKPOINT_REQUIRED');
    expect(await sql`select id from app.posts where id=${post}`).toHaveLength(0);expect((await readJournalControl(store)).value.pending).toHaveLength(1);
  });
  it('clears obsolete group ciphertext and its author key without bypassing runtime signature checks',async()=>{
    const member=randomUUID(),device=randomUUID(),group=randomUUID();
    await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
    await sql`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${member},${'test-public-key'.repeat(10)},${'a'.repeat(64)},'{}')`;
    const envelope=(revision:number)=>({context:{revision,authorId:member,authorDeviceId:device},ciphertext:'encrypted-group-'+revision});
    await sql`insert into app.groups(id,owner_id,envelope) values(${group},${member},${sql.json(envelope(1))})`;
    const store=new MemoryStore();const db:JournalDatabase={async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
    await initializePrivacyJournal(store,db);await activate(store);const before=await db.status();
    const intent=await beginPrivacyIntent(store,db);await sql`update app.groups set envelope=${sql.json(envelope(2))} where id=${group}`;await completePrivacyIntent(store,db,intent);
    await quarantineJournal(store,'group_restore_test');
    await sql.begin(async tx=>{await tx`select set_config('app.restore_replay','on',true)`;await tx`update app.groups set envelope=${tx.json(envelope(1))} where id=${group}`;await tx`delete from app.safety_journal where sequence>${before.sequence}::bigint`;await tx`update app.safety_journal_state set sequence=${before.sequence}::bigint`;});
    await replayPrivacyJournal(store,sql,async()=>{});
    const [result]=await sql`select envelope,author_key from app.groups where id=${group}`;expect(result.envelope).toEqual({});expect(result.author_key).toBeNull();
    await expect(sql`update app.groups set envelope='{}' where id=${group}`).rejects.toMatchObject({code:'P0001'});
    await releasePrivacyQuarantine(store,sql);
  });
});
