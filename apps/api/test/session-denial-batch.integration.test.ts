import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {deleteDeniedSession} from '../src/session-denial-cleanup';
import {persistSessionDenial} from '../src/session-denial';
import {drainSessionCandidates,listSessionCandidates,candidateProgressKey,parseCandidateProgress} from '../src/session-denial-candidates';
import {deleteDeniedSessionBatch,denialDeleteBatchLimit} from '../src/session-denial-batch';

const base=process.env.TEST_DATABASE_URL,suffix=randomUUID().replaceAll('-','');
const database='porchday_denial_batch_'+suffix,role='porchday_denial_batch_role_'+suffix;
let admin:Pool,owner:Pool,runtime:Pool,calls=0;
let before:((sql:string)=>Promise<void>)|undefined,after:((sql:string)=>Promise<void>)|undefined;
async function person(){const id=randomUUID();await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,'Synthetic batch',id+'@example.test']);return id;}
async function sessions(member:string,count:number){const ids=Array.from({length:count},()=>randomUUID());await restore(member,ids);return ids;}
async function restore(member:string,ids:string[]){for(const id of ids)await owner.query("INSERT INTO public.auth_session(id,\"expiresAt\",token,\"userId\") VALUES($1,now()+interval '7 days',$2,$3)",[id,randomUUID(),member]);}
async function remaining(ids:string[]){return Number((await owner.query('SELECT count(*) AS n FROM public.auth_session WHERE id=ANY($1::text[])',[ids])).rows[0].n);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
afterEach(()=>{before=undefined;after=undefined;vi.restoreAllMocks();});

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
  runtime.on('connect',client=>{const original=client.query.bind(client);client.query=(async(input:{text:string;values?:unknown[]})=>{calls++;await before?.(input.text);const result=await original(input);await after?.(input.text);return result;}) as typeof client.query;});
 },30000);
 afterAll(async()=>{
  if(runtime)await runtime.end();if(owner)await owner.end();
  if(admin)try{for(let n=0;n<200;n++){if(Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n)===0)break;if(n===199)throw Error('DISPOSABLE_DATABASE_DID_NOT_DRAIN');await new Promise(r=>setTimeout(r,25));}await admin.query('DROP DATABASE IF EXISTS '+database);await admin.query('DROP ROLE IF EXISTS '+role);}finally{await admin.end();}
 });
 it('amortizes a same-member backlog while retaining unrelated sessions and idempotence',async()=>{
  const member=await person(),ids=await sessions(member,24),unrelated=await sessions(member,1);calls=0;
  for(const id of ids)expect(await deleteDeniedSession(runtime,id)).toBe(true);const scalarCalls=calls;
  await restore(member,ids);calls=0;expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set(ids)});const batchCalls=calls;
  expect(batchCalls).toBeLessThanOrEqual(scalarCalls/4);expect(await remaining(ids)).toBe(0);expect(await remaining(unrelated)).toBe(1);
  expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set()});
  console.log(JSON.stringify({denialBatchComparison:{sessions:24,members:1,scalarSqlCalls:scalarCalls,batchSqlCalls:batchCalls,networkLatencyInjected:false}}));
 });
 it('bounds round trips for a backlog spread across 24 distinct members',async()=>{
  const ids:string[]=[];for(let n=0;n<24;n++)ids.push(...await sessions(await person(),1));
  calls=0;expect(await deleteDeniedSessionBatch(runtime,ids)).toEqual({completed:ids.length,deleted:new Set(ids)});
  expect(calls).toBe(148);expect(await remaining(ids)).toBe(0);
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
  expect(await deleteDeniedSessionBatch(runtime,ids,deadline)).toEqual({completed:4,deleted:new Set()});expect(calls).toBe(4);
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
