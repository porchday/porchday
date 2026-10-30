import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {readdir,readFile} from 'node:fs/promises';
import postgres,{type Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProcessJournalStore} from './fixtures/commit-process-store';
import {initializePrivacyJournal,readJournalControl,checkpointJournal,assertJournalReadable,type JournalDatabase} from '../src/privacy-journal';
import {provePrivacyCommits} from '../src/privacy-commit-proof';

const url=process.env.PRIVACY_COMMIT_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
let owner:Sql,auth:Sql,generation:string;
const digest='a'.repeat(64);
async function fixture(){const id=randomUUID();await owner`insert into public.commit_fixture(id,value) values(${id},0)`;return id;}
async function value(id:string){return Number((await owner`select value from public.commit_fixture where id=${id}`)[0].value);}
async function cursor(){return String((await owner`select sequence from app.safety_journal_state where id`)[0].sequence);}
async function run(id:string,operation:string,hash=digest,rollback=false){
 return auth.begin(async tx=>{
  await tx`update public.commit_fixture set value=value+1 where id=${id}`;
  const [row]=await tx`select app.complete_privacy_transaction(${operation}::uuid,${hash},${generation}::uuid) as sequence`;
  if(rollback)throw Error('ROLLBACK_FIXTURE');return String(row.sequence);
 });
}
suite('Atomic privacy commit marker and restore compatibility',()=>{
 beforeAll(async()=>{
  if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname)||!new URL(url).pathname.endsWith('/porchday_commit_proof_test'))throw Error('DISPOSABLE_LOCAL_COMMIT_PROOF_DATABASE_REQUIRED');
  owner=postgres(url,{max:3,prepare:false,onnotice:()=>{}});
  await owner`drop schema if exists app cascade`;await owner`drop schema public cascade`;await owner`create schema public`;
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await owner.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await owner.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_commit_auth_test') THEN CREATE ROLE porchday_commit_auth_test LOGIN PASSWORD 'local-commit-proof-only' IN ROLE porchday_auth; END IF; END $$");
  await owner`create table public.commit_fixture(id uuid primary key,value integer not null)`;
  await owner`grant select,update on public.commit_fixture to porchday_auth`;
  generation=(await owner`select generation from app.safety_journal_state where id`)[0].generation;
  const connection=new URL(url);connection.username='porchday_commit_auth_test';connection.password='local-commit-proof-only';auth=postgres(connection.href,{max:2,prepare:false,onnotice:()=>{}});
 },30000);
 afterAll(async()=>{await auth?.end();await owner?.end();});
 it('commits SQL work, marker, counter and unique fence atomically',async()=>{
  const id=await fixture(),operation=randomUUID(),sequence=await run(id,operation);
  expect(await value(id)).toBe(1);
  const [event]=await owner`select decision from app.safety_journal where sequence=${sequence}`;
  expect(event.decision).toEqual({kind:'privacy_operation_committed',operation_id:operation,scope_sha256:digest});
  const [fence]=await owner`select scope_sha256,generation,sequence::text from app.privacy_operation_commits where operation_id=${operation}`;
  expect(fence).toEqual({scope_sha256:digest,generation,sequence});
 });
 it('rolls back every part, including the sequence allocation',async()=>{
  const id=await fixture(),operation=randomUUID(),before=await cursor();
  await expect(run(id,operation,digest,true)).rejects.toThrow('ROLLBACK_FIXTURE');
  expect(await value(id)).toBe(0);expect(await cursor()).toBe(before);
  expect(await owner`select 1 from app.privacy_operation_commits where operation_id=${operation}`).toHaveLength(0);
  expect(await owner`select 1 from app.safety_journal where decision->>'operation_id'=${operation}`).toHaveLength(0);
 });
 it('aborts a duplicate attempt instead of returning the previous completion',async()=>{
  const id=await fixture(),operation=randomUUID();await run(id,operation);const before=await cursor();
  for(const hash of [digest,'b'.repeat(64)])await expect(run(id,operation,hash)).rejects.toMatchObject({code:'23505'});
  expect(await value(id)).toBe(1);expect(await cursor()).toBe(before);
 });
 it('allows only one of two concurrent attempts to commit',async()=>{
  const a=await fixture(),b=await fixture(),operation=randomUUID();
  const results=await Promise.allSettled([run(a,operation),run(b,operation)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await value(a)+await value(b)).toBe(1);
  expect(await owner`select 1 from app.safety_journal where decision->>'operation_id'=${operation}`).toHaveLength(1);
 });
 it('refuses a wrong generation, quarantine and restore suppression',async()=>{
  const id=await fixture(),before=await cursor();
  await expect(auth.begin(async tx=>{await tx`update public.commit_fixture set value=9 where id=${id}`;await tx`select app.complete_privacy_transaction(${randomUUID()}::uuid,${digest},${randomUUID()}::uuid)`;})).rejects.toThrow('DATABASE_ROLLBACK_DETECTED');
  await owner`update app.safety_journal_state set restore_quarantined=true where id`;
  try{await expect(run(id,randomUUID())).rejects.toThrow('RESTORE_QUARANTINED');}finally{await owner`update app.safety_journal_state set restore_quarantined=false where id`;}
  await expect(auth.begin(async tx=>{await tx`select set_config('app.restore_replay','on',true)`;await tx`select app.complete_privacy_transaction(${randomUUID()}::uuid,${digest},${generation}::uuid)`;})).rejects.toThrow('RESTORE_QUARANTINED');
  expect(await value(id)).toBe(0);expect(await cursor()).toBe(before);
 });
 it('refuses malformed scopes without allocating a marker',async()=>{
  const before=await cursor();
  for(const hash of ['',null,'A'.repeat(64),'a'.repeat(63)])await expect(auth`select app.complete_privacy_transaction(${randomUUID()}::uuid,${hash},${generation}::uuid)`).rejects.toThrow('INVALID_PRIVACY_COMMIT_SCOPE');
  await expect(auth`select app.complete_privacy_transaction(null,${digest},${generation}::uuid)`).rejects.toThrow('INVALID_PRIVACY_COMMIT_SCOPE');
  await expect(auth`select app.complete_privacy_transaction(${randomUUID()}::uuid,${digest},null)`).rejects.toThrow('INVALID_PRIVACY_COMMIT_SCOPE');
  expect(await cursor()).toBe(before);
 });
 it('does not grant runtime roles direct fence access or non-auth marker execution',async()=>{
  await expect(auth`select * from app.privacy_operation_commits`).rejects.toMatchObject({code:'42501'});
  await expect(auth`delete from app.privacy_operation_commits`).rejects.toMatchObject({code:'42501'});
  for(const role of ['porchday_social','porchday_jobs'])await expect(owner.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE '+role);await tx`select app.complete_privacy_transaction(${randomUUID()}::uuid,${digest},${generation}::uuid)`;})).rejects.toMatchObject({code:'42501'});
 });
 it('restores a validated marker and fence without changing application data',async()=>{
  const id=await fixture(),operation=randomUUID(),sequence=await run(id,operation);
  const [event]=await owner`select sequence::text,id,occurred_at,decision from app.safety_journal where sequence=${sequence}`;
  await owner.begin(async tx=>{
   await tx`update app.safety_journal_state set restore_quarantined=true where id`;
   await tx`delete from app.privacy_operation_commits where operation_id=${operation}`;await tx`delete from app.safety_journal where sequence=${sequence}`;
   for(let i=0;i<2;i++)expect((await tx`select app.replay_safety_batch(${tx.json([event])}) as count`)[0].count).toBe(1);
   expect((await tx`select value from public.commit_fixture where id=${id}`)[0].value).toBe(1);
   expect(await tx`select 1 from app.privacy_operation_commits where operation_id=${operation} and sequence=${sequence}`).toHaveLength(1);
   await tx`update app.safety_journal_state set restore_quarantined=false where id`;
  });
  await expect(run(id,operation)).rejects.toMatchObject({code:'23505'});
 });
 it('rejects malformed or conflicting replay markers',async()=>{
  const operation=randomUUID(),id=await fixture(),sequence=await run(id,operation);
  const [event]=await owner`select sequence::text,id,occurred_at,decision from app.safety_journal where sequence=${sequence}`;
  for(const decision of [
   {kind:'privacy_operation_committed',operation_id:operation},
   {...event.decision,scope_sha256:123}, {...event.decision,operation_id:'not-a-uuid'},
   {...event.decision,extra:true},{...event.decision,action:'delete'},
  ])await expect(owner.begin(async tx=>{await tx`update app.safety_journal_state set restore_quarantined=true where id`;await tx`select app.replay_safety_batch(${tx.json([{...event,decision}])})`;})).rejects.toThrow('INVALID_PRIVACY_COMMIT_MARKER');
  for(const changed of [{...event,decision:{...event.decision,scope_sha256:'b'.repeat(64)}},{...event,sequence:String(BigInt(sequence)+1n)}])await expect(owner.begin(async tx=>{await tx`update app.safety_journal_state set restore_quarantined=true where id`;await tx`select app.replay_safety_batch(${tx.json([changed])})`;})).rejects.toThrow('PRIVACY_COMMIT_FENCE_CONFLICT');
  expect(await value(id)).toBe(1);expect((await owner`select restore_quarantined from app.safety_journal_state where id`)[0].restore_quarantined).toBe(false);
 });
 it('retains legacy restore actions and the operator quarantine requirement',async()=>{
  const event={sequence:String(BigInt(await cursor())+1n),id:randomUUID(),occurred_at:new Date().toISOString(),decision:{action:'deadline',kind:'posts',id:randomUUID(),expires_at:new Date().toISOString()}};
  await expect(owner`select app.replay_safety_batch(${owner.json([event])})`).rejects.toThrow('RESTORE_QUARANTINE_REQUIRED');
  await owner.begin(async tx=>{await tx`update app.safety_journal_state set restore_quarantined=true where id`;expect((await tx`select app.replay_safety_batch(${tx.json([event])}) as count`)[0].count).toBe(1);await tx`delete from app.safety_journal where sequence=${event.sequence}`;await tx`update app.safety_journal_state set restore_quarantined=false where id`;});
 });
 it.each(['registered','before-commit','after-commit','after-checkpoint','after-receipt','after-retirement'])('retains authoritative evidence after SIGKILL at %s',async phase=>{
  const directory=await mkdtemp(join(tmpdir(),'porchday-commit-process-')),store=new ProcessJournalStore(directory),id=await fixture();
  const db:JournalDatabase={async status(){return(await owner`select app.safety_status() as value`)[0].value;},async page(after){return(await owner`select app.safety_page(${after}::bigint,200) as value`)[0].value;}};
  await initializePrivacyJournal(store,db);const initial=await readJournalControl(store);
  await store.put('control.json',JSON.stringify({...initial.value,mode:'active',reason:null}),{onlyIf:{etagMatches:initial.etag}});
  const child=fork(new URL('./fixtures/commit-process-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,COMMIT_PROCESS_DATABASE_URL:url!,COMMIT_PROCESS_DIRECTORY:directory,COMMIT_PROCESS_PHASE:phase,COMMIT_PROCESS_FIXTURE:id},stdio:['ignore','ignore','ignore','ipc']});
  let operationId='',exited=false;const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
  try{
   await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('CHILD_BOUNDARY_TIMEOUT')),10000);
    child.once('error',()=>{clearTimeout(timer);reject(Error('CHILD_SPAWN_FAILED'));});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('CHILD_EXITED_BEFORE_BOUNDARY'));});
    child.on('message',(message:any)=>{
     if(message.operationId)operationId=message.operationId;
     if(message.failed){clearTimeout(timer);reject(Error('CHILD_FAILED'));}
     if(message.phase===phase){clearTimeout(timer);resolve();}
    });
   });
   expect(operationId).toMatch(/^[a-f0-9-]{36}$/);expect(child.kill('SIGKILL')).toBe(true);
   expect((await exit).signal).toBe('SIGKILL');
   const committed=!['registered','before-commit'].includes(phase);
   expect(await value(id)).toBe(committed?1:0);
   let control=(await readJournalControl(store)).value;
   const before=await provePrivacyCommits(store,control);
   expect(before.has(operationId)).toBe(['after-checkpoint','after-receipt'].includes(phase));
   await checkpointJournal(store,db);control=(await readJournalControl(store)).value;
   expect((await provePrivacyCommits(store,control)).has(operationId)).toBe(committed&&phase!=='after-retirement');
   expect(!!await store.get(`receipts/${operationId}.json`)).toBe(['after-receipt','after-retirement'].includes(phase));
   if(phase==='after-retirement'){expect(control.pending).toHaveLength(0);await expect(assertJournalReadable(store,db)).resolves.toBeDefined();}
   else expect(control.pending.map(p=>p.id)).toContain(operationId); // Proof is read-only; it never retires the operation.
   const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001);
   try{
    if(committed){
     await expect(assertJournalReadable(store,db,undefined,true)).resolves.toBeDefined();
     expect((await readJournalControl(store)).value.pending).toHaveLength(0);
     expect(await store.get(`receipts/${operationId}.json`)).not.toBeNull();
    }else{
     await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow('RESTORE_QUARANTINED');
     expect((await readJournalControl(store)).value.pending.map(p=>p.id)).toContain(operationId);
     expect(await store.get(`receipts/${operationId}.json`)).toBeNull();
    }
   }finally{clock.mockRestore();}
  }finally{if(!exited){child.kill('SIGKILL');await exit;}await rm(directory,{recursive:true,force:true});}
 },15000);
});
