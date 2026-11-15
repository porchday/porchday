import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {deleteDeniedSession} from '../src/session-denial-cleanup';
import {denialPartitions,listPartitionCandidates,partitionProgressKey,parsePartitionProgress} from '../src/session-denial-partitions';
import {cleanupDenialPartition} from '../src/session-denial-runtime';
import type {Env} from '../src/types';
import {persistSessionDenial} from '../src/session-denial';
import {drainSessionCandidates,listSessionCandidates,candidateProgressKey,parseCandidateProgress} from '../src/session-denial-candidates';
import {deleteDeniedSessionBatch,denialDeleteBatchLimit} from '../src/session-denial-batch';

const base=process.env.TEST_DATABASE_URL,suffix=randomUUID().replaceAll('-','');
const database='porchday_denial_batch_'+suffix,role='porchday_denial_batch_role_'+suffix;
let admin:Pool,owner:Pool,runtime:Pool,calls=0;
let before:((sql:string)=>Promise<void>)|undefined,after:((sql:string)=>Promise<void>)|undefined;
let inspectSetup=false,failInsideSetup=false;const setupObservations:{readonly:string;statement:string;lock:string}[]=[];
async function person(){const id=randomUUID();await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,'Synthetic batch',id+'@example.test']);return id;}
async function sessions(member:string,count:number){const ids=Array.from({length:count},()=>randomUUID());await restore(member,ids);return ids;}
async function restore(member:string,ids:string[]){for(const id of ids)await owner.query("INSERT INTO public.auth_session(id,\"expiresAt\",token,\"userId\") VALUES($1,now()+interval '7 days',$2,$3)",[id,randomUUID(),member]);}
async function remaining(ids:string[]){return Number((await owner.query('SELECT count(*) AS n FROM public.auth_session WHERE id=ANY($1::text[])',[ids])).rows[0].n);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
afterEach(()=>{before=undefined;after=undefined;inspectSetup=false;failInsideSetup=false;setupObservations.length=0;vi.restoreAllMocks();});

describe('denial batch bounds',()=>{
 it('refuses oversized, duplicate or malformed authority lists before SQL',async()=>{
  const connect=vi.fn();const pool={connect} as unknown as Pool,id=randomUUID();
  for(const ids of [Array.from({length:denialDeleteBatchLimit+1},()=>randomUUID()),[id,id],['not-a-session']])await expect(deleteDeniedSessionBatch(pool,ids)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
  expect(await deleteDeniedSessionBatch(pool,[id],Date.now()-1)).toEqual({completed:0,deleted:new Set()});expect(connect).not.toHaveBeenCalled();expect(await deleteDeniedSessionBatch(pool,[])).toEqual({completed:0,deleted:new Set()});
 });
});

(base?describe:describe.skip)('denial batch through restricted PostgreSQL auth role',()=>{
 beforeAll(async()=>{
  const url=new URL(base!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Disposable loopback database required');
  url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;owner=new Pool({connectionString:url.href,max:3});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await owner.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-denial-batch' IN ROLE porchday_auth`);url.username=role;url.password='synthetic-denial-batch';runtime=new Pool({connectionString:url.href,max:1});
  runtime.on('connect',client=>{const original=client.query.bind(client);client.query=(async(input:{text:string;values?:unknown[]})=>{calls++;await before?.(input.text);const result=await original(failInsideSetup&&input.text.startsWith('BEGIN;')?{...input,text:input.text+'; SELECT 1/0'}:input);
   if(inspectSetup&&(input.text.startsWith('BEGIN')||input.text==='COMMIT'||input.text==='ROLLBACK'))setupObservations.push((await original("SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).rows[0]);
   await after?.(input.text);return result;}) as typeof client.query;});
 },30000);
 afterAll(async()=>{
  if(runtime)await runtime.end();if(owner)await owner.end();
  if(admin)try{for(let n=0;n<200;n++){if(Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n)===0)break;if(n===199)throw Error('DISPOSABLE_DATABASE_DID_NOT_DRAIN');await new Promise(r=>setTimeout(r,25));}await admin.query('DROP DATABASE IF EXISTS '+database);await admin.query('DROP ROLE IF EXISTS '+role);}finally{await admin.end();}
 });
 it('covers the SQL ordering exactly once across ranges and refuses foreign cursors',async()=>{
  const member=await person();await sessions(member,400);await restore(member,['4z','5','9z','a','zz','é']);
  const expected=(await owner.query('SELECT id FROM public.auth_session ORDER BY id')).rows.map(row=>row.id),seen:string[]=[];
  for(const partition of denialPartitions){let after:string|null=null,pages=0;for(;;){const page=await listPartitionCandidates(runtime,partition,after);expect(page.ids.length).toBeLessThanOrEqual(100);seen.push(...page.ids);pages++;if(!page.more)break;after=page.ids.at(-1)!;expect(pages).toBeLessThan(10);}}
  expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(expected.length);
  for(const [partition,after]of [[0,'5'],[1,'4z'],[1,'a'],[2,'9z']] as const)await expect(listPartitionCandidates(runtime,partition,after)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
  // Failed read-only transactions must be discarded; later valid work recovers.
  expect((await listPartitionCandidates(runtime,2,'a')).ids).toEqual(expected.slice(expected.indexOf('a')+1,expected.indexOf('a')+101));
  await owner.query('DELETE FROM public.auth_session WHERE "userId"=$1',[member]);await owner.query('DELETE FROM public.auth_user WHERE id=$1',[member]);
 });
 it('runs three independent ranges and an overlapping duplicate against real SQL without deleting live sessions',async()=>{
  const denied:string[]=[],live:string[]=[],members:string[]=[];for(let n=0;n<12;n++){const member=await person();members.push(member);denied.push(...await sessions(member,35));live.push(...await sessions(member,1));}
  const records=new Map<string,{etag:string;text:string}>();let version=0;
  const store={get:async(key:string)=>{const row=records.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;},put:async(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}})=>{
   const old=records.get(key),condition=options?.onlyIf;if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
   const etag=String(++version);records.set(key,{etag,text});return {etag};
  }};
  for(const id of denied)await persistSessionDenial(store,id);
  const env={SESSION_DENIAL_CLEANUP_V1:'true',SESSION_DENIAL_PARTITIONS_V1:'active',HYPERDRIVE_AUTH:{connectionString:runtime.options.connectionString},RECOVERY_JOURNAL:store} as unknown as Env;
  const outcomes=await Promise.allSettled([0,1,2,0].map(partition=>cleanupDenialPartition(env,partition)));for(const outcome of outcomes){expect(outcome.status).toBe('fulfilled');if(outcome.status==='fulfilled')expect(outcome.value.continuation).toBeUndefined();}
  expect(await remaining(denied)).toBe(0);expect(await remaining(live)).toBe(12);expect(records.has(candidateProgressKey)).toBe(false);
  for(const partition of denialPartitions)expect(parsePartitionProgress(records.get(partitionProgressKey(partition))!.text,partition).cursor).toBeNull();
  await owner.query('DELETE FROM public.auth_session WHERE "userId"=ANY($1::text[])',[members]);await owner.query('DELETE FROM public.auth_user WHERE id=ANY($1::text[])',[members]);
 });
 it('amortizes a same-member backlog while retaining unrelated sessions and idempotence',async()=>{
  const member=await person(),ids=await sessions(member,24),unrelated=await sessions(member,1);calls=0;
  for(const id of ids)expect(await deleteDeniedSession(runtime,id)).toBe(true);const scalarCalls=calls;
  await restore(member,ids);calls=0;expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set(ids)});const batchCalls=calls;
  expect(scalarCalls).toBe(120);expect(batchCalls).toBe(7);expect(batchCalls).toBeLessThanOrEqual(scalarCalls/4);expect(await remaining(ids)).toBe(0);expect(await remaining(unrelated)).toBe(1);
  expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set()});
  console.log(JSON.stringify({denialBatchComparison:{sessions:24,members:1,scalarSqlCalls:scalarCalls,batchSqlCalls:batchCalls,networkLatencyInjected:false}}));
 });
 it('bounds round trips for a backlog spread across 24 distinct members',async()=>{
  const ids:string[]=[];for(let n=0;n<24;n++)ids.push(...await sessions(await person(),1));
  calls=0;expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set(ids)});
  expect(calls).toBe(99);expect(await remaining(ids)).toBe(0);
 });
 it('drains real SQL candidates using verified authority and leaves live sessions intact',async()=>{
  const member=await person(),ids=await sessions(member,120),live=await sessions(member,4);
  const records=new Map<string,{etag:string;text:string}>();let version=0;
  const store={get:async(key:string)=>{const record=records.get(key);return record?{etag:record.etag,text:async()=>record.text}:null;},
   put:async(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}})=>{
    const old=records.get(key),condition=options?.onlyIf;
    if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
    const etag=String(++version);records.set(key,{etag,text});return {etag};
   }};
  for(const id of ids)await persistSessionDenial(store,id);
  let token:string|undefined,total=0;
  for(let n=0;n<10;n++){
   const result=await drainSessionCandidates(store,after=>listSessionCandidates(runtime,after),id=>deleteDeniedSession(runtime,id),token,undefined,(ids,deadline)=>deleteDeniedSessionBatch(runtime,ids,deadline));
   total+=result.deleted;token=result.continuation;if(!token)break;
  }
  expect(token).toBeUndefined();expect(total).toBe(120);expect(await remaining(ids)).toBe(0);expect(await remaining(live)).toBe(4);
  expect(parseCandidateProgress(records.get(candidateProgressKey)!.text).cursor).toBeNull();
  expect(records.size).toBe(121); // Immutable denials survive cleanup.
 });
 it('retains local timeouts and read-only metadata setup, resetting settings on every commit',async()=>{
  const ids=await sessions(await person(),4);inspectSetup=true;
  await deleteDeniedSessionBatch(runtime,ids);
  expect(setupObservations).toEqual([
   {readonly:'on',statement:'5s',lock:'0'}, {readonly:'off',statement:'0',lock:'0'},
   {readonly:'off',statement:'5s',lock:'5s'}, {readonly:'off',statement:'0',lock:'0'},
  ]);
  setupObservations.length=0;const scalar=await sessions(await person(),1);await deleteDeniedSession(runtime,scalar[0]);
  expect(setupObservations).toEqual([{readonly:'off',statement:'5s',lock:'5s'},{readonly:'off',statement:'0',lock:'0'}]);
 });
 it('rolls back a server error inside compound setup without leaving settings or deletions behind',async()=>{
  for(const count of [1,4]){
   const ids=await sessions(await person(),count);let rollbacks=0;inspectSetup=true;failInsideSetup=true;
   before=async sql=>{if(sql==='ROLLBACK')rollbacks++;};
   await expect(deleteDeniedSessionBatch(runtime,ids)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
   before=undefined;failInsideSetup=false;expect(rollbacks).toBe(1);expect(setupObservations.at(-1)).toEqual({readonly:'off',statement:'0',lock:'0'});expect(await remaining(ids)).toBe(count);
   expect((await deleteDeniedSessionBatch(runtime,ids)).deleted.size).toBe(count);
  }
 });
 it('rolls back an acknowledged setup when its reply is lost, before deleting any session',async()=>{
  for(const count of [1,4]){
   const ids=await sessions(await person(),count);let rollbacks=0;
   before=async sql=>{if(sql==='ROLLBACK')rollbacks++;};
   after=async sql=>{if(sql.startsWith('BEGIN;'))throw Error('lost setup reply');};
   await expect(deleteDeniedSessionBatch(runtime,ids)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
   before=undefined;after=undefined;expect(rollbacks).toBe(1);expect(await remaining(ids)).toBe(count);
   expect((await deleteDeniedSessionBatch(runtime,ids)).deleted.size).toBe(count);
  }
 });
 it('rolls back the member group when deletion fails before commit',async()=>{
  const ids=await sessions(await person(),4);before=async sql=>{if(sql.startsWith('DELETE'))throw Error('synthetic transport failure');};
  await expect(deleteDeniedSessionBatch(runtime,ids)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');before=undefined;expect(await remaining(ids)).toBe(4);
 });
 it('retains unknown commit semantics and converges when exact deletions are repeated',async()=>{
  const members=[await person(),await person()].sort(),first=await sessions(members[0],4),second=await sessions(members[1],4);let commits=0;
  after=async sql=>{if(sql==='COMMIT'&&++commits===2)throw Error('lost commit reply');};
  await expect(deleteDeniedSessionBatch(runtime,[...first,...second])).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');after=undefined;
  expect(await remaining(first)).toBe(0);expect(await remaining(second)).toBe(4);expect(await deleteDeniedSessionBatch(runtime,[...first,...second])).toEqual({completed:8,deleted:new Set(second)});
 });
 it('rechecks the captured owner after waiting for its identity lock',async()=>{
  const member=await person(),other=await person(),ids=await sessions(member,4),entered=deferred(),lock=await owner.connect();await lock.query('BEGIN');await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[member]);
  before=async sql=>{if(sql.includes('pg_advisory_xact_lock'))entered.resolve();};
  const pending=deleteDeniedSessionBatch(runtime,ids);try{await entered.promise;await lock.query('UPDATE public.auth_session SET "userId"=$1 WHERE id=$2',[other,ids[0]]);await lock.query('COMMIT');expect(await pending).toEqual({completed:ids.length,deleted:new Set(ids.slice(1))});expect(await remaining([ids[0]])).toBe(1);}finally{await lock.query('ROLLBACK');lock.release();await pending.catch(()=>{});}
 });
 it('releases each member lock before waiting for another member',async()=>{
  const members=[await person(),await person()].sort(),first=await sessions(members[0],4),second=await sessions(members[1],4),entered=deferred(),lock=await owner.connect();await lock.query('BEGIN');await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[members[1]]);let locks=0;
  before=async sql=>{if(sql.includes('pg_advisory_xact_lock')&&++locks===2)entered.resolve();};
  const pending=deleteDeniedSessionBatch(runtime,[...first,...second]);try{await entered.promise;expect(await remaining(first)).toBe(0);const check=await owner.connect();try{await check.query('BEGIN');expect((await check.query("SELECT pg_try_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0)) AS acquired",[members[0]])).rows[0].acquired).toBe(true);await check.query('ROLLBACK');}finally{check.release();}await lock.query('COMMIT');expect((await pending).deleted.size).toBe(8);}finally{await lock.query('ROLLBACK');lock.release();await pending.catch(()=>{});}
 });
 it('acknowledges already-absent IDs without starting an owner transaction after the deadline',async()=>{
  const ids=Array.from({length:4},()=>randomUUID());let now=Date.now();const deadline=now+20000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  after=async sql=>{if(sql==='COMMIT')now=deadline;};calls=0;
  expect(await deleteDeniedSessionBatch(runtime,ids,deadline)).toEqual({completed:4,deleted:new Set()});expect(calls).toBe(3);
 });
 it('keeps scalar fallback progress when its first confirmed commit exhausts the budget',async()=>{
  const ids=await sessions(await person(),3);let now=Date.now();const deadline=now+20000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  after=async sql=>{if(sql==='COMMIT')now=deadline;};
  expect(await deleteDeniedSessionBatch(runtime,ids,deadline)).toEqual({completed:1,deleted:new Set([ids[0]])});after=undefined;vi.restoreAllMocks();expect(await remaining(ids)).toBe(2);
 });
 it('reports only the committed input prefix when owners are interleaved and the budget ends',async()=>{
  const members=[await person(),await person()].sort().reverse(),first=await sessions(members[0],4),second=await sessions(members[1],4),ids=[first[0],second[0],...first.slice(1),...second.slice(1)];
  let now=Date.now(),commits=0;const deadline=now+20000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  after=async sql=>{if(sql==='COMMIT'&&++commits===2)now=deadline;};
  expect(await deleteDeniedSessionBatch(runtime,ids,deadline)).toEqual({completed:1,deleted:new Set([first[0]])});
  after=undefined;vi.restoreAllMocks();expect(await remaining(first)).toBe(0);expect(await remaining(second)).toBe(4);
  expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:8,deleted:new Set(second)});
 });
 it('starts no new member transaction after the work deadline and safely repeats partial progress',async()=>{
  const members=[await person(),await person()].sort(),first=await sessions(members[0],4),second=await sessions(members[1],4);let now=Date.now(),commits=0;const deadline=now+20000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  after=async sql=>{if(sql==='COMMIT'&&++commits===2)now=deadline;};expect(await deleteDeniedSessionBatch(runtime,[...first,...second],deadline)).toEqual({completed:4,deleted:new Set(first)});after=undefined;vi.restoreAllMocks();expect(await remaining(first)).toBe(0);expect(await remaining(second)).toBe(4);expect(await deleteDeniedSessionBatch(runtime,[...first,...second])).toEqual({completed:8,deleted:new Set(second)});
 });
});
