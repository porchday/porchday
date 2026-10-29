import {describe,it,expect,vi} from 'vitest';
import {persistSessionDenial} from '../src/session-denial';
import {candidateProgressKey,parseCandidateProgress,candidateProgressHealth,sweepSessionCandidates,cleanupDeniedSessionCandidates,readCandidateCleanupHealth} from '../src/session-denial-candidates';
import {denialProgressKey,readDenialCleanupHealth} from '../src/session-denial-progress';
import {sweepSessionDenials} from '../src/session-denial-cleanup';
import type {Env} from '../src/types';
const id=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
async function fixture(count=1){
 const records=new Map<string,{etag:string;text:string}>(),sessions=new Set<string>();let version=0;
 const store={get:vi.fn(async(key:string)=>{const row=records.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}),
  put:vi.fn(async(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}})=>{
   const old=records.get(key),condition=options?.onlyIf;
   if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
   const etag=String(++version);records.set(key,{etag,text});return {etag};
  })};
 for(let i=1;i<=count;i++)sessions.add(id(i));
 const list=vi.fn(async(after:string|null)=>{const ids=[...sessions].filter(id=>after===null||id>after).sort();return {ids:ids.slice(0,100),more:ids.length>100};});
 const cleanup=vi.fn(async(id:string)=>sessions.delete(id));
 const sweep=()=>sweepSessionCandidates(store,list,cleanup);
 const progress=()=>parseCandidateProgress(records.get(candidateProgressKey)!.text);
 return {records,sessions,store,list,cleanup,sweep,progress};
}
describe('SQL candidate denial discovery',()=>{
 it('ignores a large immutable history while retaining canonical authority for exact deletion',async()=>{
  const f=await fixture(3);
  // Historical objects can exist in arbitrary volume without a LIST or read.
  for(let n=1;n<=10000;n++)f.records.set('session-denials/v1/historical-'+n,{etag:'old',text:'untouched'});
  await persistSessionDenial(f.store,id(1));f.store.get.mockClear();f.store.put.mockClear();
  expect(await f.sweep()).toEqual({seen:3,deleted:1,invalid:0,advanced:false});
  expect([...f.sessions]).toEqual([id(2),id(3)]);expect(f.store.get).toHaveBeenCalledTimes(4);
  expect(f.records.size).toBe(10002);expect(f.store.put).toHaveBeenCalledTimes(1);
  expect(f.progress().lastPass?.seen).toBe(3);expect(candidateProgressHealth(f.progress()).issues).toEqual([]);
 });
 it('wraps and discovers restored rows inserted behind the cursor, including expired candidates',async()=>{
  const f=await fixture(101);await persistSessionDenial(f.store,id(1));
  expect((await f.sweep()).seen).toBe(100);expect(f.progress().cursor).toBe(id(100));
  f.sessions.add(id(1)); // Restore previously deleted SQL row, immutable authority survives.
  expect((await f.sweep()).seen).toBe(1);expect(f.sessions.has(id(1))).toBe(true);
  expect(f.progress().cursor).toBeNull();expect(f.progress().lastPass?.seen).toBe(101);
  expect((await f.sweep()).deleted).toBe(1);expect(f.sessions.has(id(1))).toBe(false);
 });
 it('checkpoints only completed candidates when the work budget ends',async()=>{
  const f=await fixture(6);await persistSessionDenial(f.store,id(1));vi.useFakeTimers();
  try{
   f.cleanup.mockImplementationOnce(async value=>{vi.setSystemTime(Date.now()+20000);return f.sessions.delete(value);});
   expect(await f.sweep()).toEqual({seen:1,deleted:1,invalid:0,advanced:true,continuation:expect.any(String)});
   expect(f.progress().cursor).toBe(id(1));expect(f.progress().lastPass).toBeNull();
   expect((await f.sweep()).seen).toBe(5);expect(f.progress().lastPass?.seen).toBe(6);
  }finally{vi.useRealTimers();}
 });
 it('does not delete after a late R2 read or publish progress for the failed page',async()=>{
  const f=await fixture();await persistSessionDenial(f.store,id(1));const get=f.store.get.getMockImplementation()!;
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  f.store.get.mockImplementation(async key=>{if(key!==candidateProgressKey)await gate;return get(key);});vi.useFakeTimers();
  try{
   const pending=f.sweep(),verdict=expect(pending).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
   await vi.advanceTimersByTimeAsync(2000);await verdict;release();await vi.advanceTimersByTimeAsync(0);
   expect(f.cleanup).not.toHaveBeenCalled();expect(f.records.has(candidateProgressKey)).toBe(false);expect(vi.getTimerCount()).toBe(0);
  }finally{release();vi.useRealTimers();}
 });
 it('repeats discovery after an unknown SQL commit and preserves unrelated sessions',async()=>{
  const f=await fixture(3);await persistSessionDenial(f.store,id(1));await persistSessionDenial(f.store,id(2));
  f.cleanup.mockImplementationOnce(async value=>{f.sessions.delete(value);throw Error('lost commit reply');});
  await expect(f.sweep()).rejects.toThrow();expect(f.records.has(candidateProgressKey)).toBe(false);
  expect((await f.sweep()).deleted).toBe(1);expect([...f.sessions]).toEqual([id(3)]);
 });
 it('continues past corrupt authority without granting deletion or healthy progress',async()=>{
  const f=await fixture(2);await persistSessionDenial(f.store,id(1));await persistSessionDenial(f.store,id(2));
  const record=[...f.records.values()][0],saved=record.text;record.text='corrupt';
  expect(await f.sweep()).toEqual({seen:2,deleted:1,invalid:1,advanced:false});
  expect(candidateProgressHealth(f.progress()).issues).toEqual(['session_denial_cleanup_invalid']);
  record.text=saved;expect((await f.sweep()).deleted).toBe(1);expect(candidateProgressHealth(f.progress()).issues).toEqual([]);
 });
 it('CAS prevents a delayed worker overwriting newer progress',async()=>{
  const f=await fixture();await persistSessionDenial(f.store,id(1));let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const slow=sweepSessionCandidates(f.store,f.list,async()=>{entered();await gate;return false;});
  try{await started;await f.sweep();const winner=f.records.get(candidateProgressKey);release();await slow;expect(f.records.get(candidateProgressKey)).toEqual(winner);}
  finally{release();await slow;}
 });
 it('reconciles a lost progress reply through the next read without broader mutation replay',async()=>{
  const f=await fixture();await persistSessionDenial(f.store,id(1));const put=f.store.put.getMockImplementation()!;
  f.store.put.mockImplementationOnce(async(...args)=>{await put(...args);throw Error('lost progress reply');});
  await expect(f.sweep()).rejects.toThrow();expect(f.progress().lastPass?.seen).toBe(1);
  expect((await f.sweep()).seen).toBe(0);expect(f.cleanup).toHaveBeenCalledTimes(1);
 });
 it('cannot refresh legacy progress or accept its evidence as SQL discovery',async()=>{
  const f=await fixture(0);f.records.set(denialProgressKey,{etag:'old',text:'legacy-evidence'});
  await f.sweep();expect(f.records.get(denialProgressKey)).toEqual({etag:'old',text:'legacy-evidence'});
  expect(()=>parseCandidateProgress(JSON.stringify({...f.progress(),v:2}))).toThrow();
  expect(()=>parseCandidateProgress(JSON.stringify({...f.progress(),strategy:'r2-history'}))).toThrow();
  expect(()=>parseCandidateProgress(JSON.stringify({...f.progress(),extra:true}))).toThrow();
 });
 it('drains 10000 live candidates in bounded continuations and stops at the full pass',async()=>{
  const f=await fixture(10000);let token:string|undefined,pages=0,total=0;
  do{
   const result=await sweepSessionCandidates(f.store,f.list,f.cleanup,token);
   expect(result.seen).toBeLessThanOrEqual(100);total+=result.seen;pages++;
   token=result.continuation;
  }while(token&&pages<101);
  expect(pages).toBe(100);expect(total).toBe(10000);expect(token).toBeUndefined();
  expect(f.progress().lastPass?.seen).toBe(10000);expect(f.progress().cursor).toBeNull();
  expect(f.cleanup).not.toHaveBeenCalled();expect(f.sessions.size).toBe(10000);
 });
 it('drops delayed continuation tokens before SQL discovery and cannot restart a completed pass',async()=>{
  const f=await fixture(101),first=await f.sweep();expect(first.continuation).toBeTruthy();
  const last=await sweepSessionCandidates(f.store,f.list,f.cleanup,first.continuation);expect(last.seen).toBe(1);expect(last.continuation).toBeUndefined();
  f.list.mockClear();f.store.put.mockClear();
  expect(await sweepSessionCandidates(f.store,f.list,f.cleanup,first.continuation)).toEqual({seen:0,deleted:0,invalid:0,advanced:false});
  expect(f.list).not.toHaveBeenCalled();expect(f.store.put).not.toHaveBeenCalled();
 });
 it('allows only the CAS winner to continue a concurrent page',async()=>{
  const f=await fixture(101);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const slow=sweepSessionCandidates(f.store,async after=>{entered();await gate;return f.list(after);},f.cleanup);
  try{await started;const winner=await f.sweep();expect(winner.continuation).toBeTruthy();release();
   const loser=await slow;expect(loser.advanced).toBe(false);expect(loser.continuation).toBeUndefined();
  }finally{release();await slow;}
 });
 it('cron resumes persisted work after a lost progress reply without trusting an old continuation',async()=>{
  const f=await fixture(201),first=await f.sweep(),put=f.store.put.getMockImplementation()!;
  f.store.put.mockImplementationOnce(async(...args)=>{await put(...args);throw Error('lost progress reply');});
  await expect(sweepSessionCandidates(f.store,f.list,f.cleanup,first.continuation)).rejects.toThrow();
  expect((await sweepSessionCandidates(f.store,f.list,f.cleanup,first.continuation)).seen).toBe(0);
  expect((await f.sweep()).seen).toBe(1);expect(f.progress().lastPass?.seen).toBe(201);
 });
 it('rejects malformed discovery pages and failed listings before any deletion',async()=>{
  for(const page of [{ids:[id(1),id(1)],more:false},{ids:[],more:true}]){
   const f=await fixture();f.list.mockResolvedValue(page);await expect(f.sweep()).rejects.toThrow();expect(f.cleanup).not.toHaveBeenCalled();expect(f.records.has(candidateProgressKey)).toBe(false);
  }
  const f=await fixture();f.list.mockRejectedValue(Error('listing failed'));await expect(f.sweep()).rejects.toThrow();expect(f.cleanup).not.toHaveBeenCalled();
 });
});

describe('scheduled candidate health and version transition',()=>{
 const env=(f:Awaited<ReturnType<typeof fixture>>)=>({SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:f.store}) as unknown as Env;
 it('keeps disabled cleanup and monitoring inert, and rejects enabled cleanup without authority',async()=>{
  const f=await fixture();
  expect(await cleanupDeniedSessionCandidates({} as Env)).toEqual({seen:0,deleted:0,invalid:0,advanced:false});
  expect(await readCandidateCleanupHealth({...env(f),SESSION_DENIAL_CLEANUP_V1:undefined})).toEqual({issues:[],snapshot:null});
  expect(f.store.get).not.toHaveBeenCalled();
  await expect(cleanupDeniedSessionCandidates({SESSION_DENIAL_CLEANUP_V1:'true'} as Env)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
 });
 it('requires real progress per version, including when rolling back after the old sweep stops',async()=>{
  const f=await fixture(0),legacy={...f.store,list:async()=>({objects:[],truncated:false})};vi.useFakeTimers();
  try{
   await sweepSessionDenials(legacy,f.cleanup);
   expect((await readDenialCleanupHealth(env(f))).issues).toEqual([]);
   expect((await readCandidateCleanupHealth(env(f))).issues).toEqual(['session_denial_cleanup_missing']);
   await f.sweep();expect((await readCandidateCleanupHealth(env(f))).issues).toEqual([]);
   const old=f.records.get(denialProgressKey);await vi.advanceTimersByTimeAsync(181000);await f.sweep();
   expect((await readCandidateCleanupHealth(env(f))).issues).toEqual([]);
   expect(f.records.get(denialProgressKey)).toEqual(old);
   expect((await readDenialCleanupHealth(env(f))).issues).toEqual(['session_denial_cleanup_stale']);
   await sweepSessionDenials(legacy,f.cleanup);
   expect((await readDenialCleanupHealth(env(f))).issues).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it('reports missing, corrupt, future and stalled candidate evidence without exposing IDs',async()=>{
  const f=await fixture(1);
  expect((await readCandidateCleanupHealth(env(f))).issues).toEqual(['session_denial_cleanup_missing']);
  f.records.set(candidateProgressKey,{etag:'bad',text:'invalid'});
  expect((await readCandidateCleanupHealth(env(f))).issues).toEqual(['session_denial_cleanup_unavailable']);
  f.records.delete(candidateProgressKey);vi.useFakeTimers();
  try{
   await f.sweep();const now=Date.now();vi.setSystemTime(now-1);
   expect((await readCandidateCleanupHealth(env(f))).issues).toEqual(['session_denial_cleanup_unavailable']);
   vi.setSystemTime(now+300001);const health=await readCandidateCleanupHealth(env(f));
   expect(health.issues).toEqual(['session_denial_cleanup_stale','session_denial_pass_stale']);
   expect(JSON.stringify(health)).not.toMatch(/cursor|11111111|session-denials/);
   await f.sweep();expect((await readCandidateCleanupHealth(env(f))).issues).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it('bounds stalled progress bodies and ignores late completion without writes',async()=>{
  const f=await fixture(0);await f.sweep();const progress=f.records.get(candidateProgressKey)!;
  let release!:(text:string)=>void;f.store.get.mockResolvedValue({etag:'held',text:()=>new Promise<string>(resolve=>{release=resolve;})});
  f.store.put.mockClear();vi.useFakeTimers();
  try{
   const pending=readCandidateCleanupHealth(env(f));await vi.advanceTimersByTimeAsync(2000);
   expect((await pending).issues).toEqual(['session_denial_cleanup_unavailable']);
   release(progress.text);await vi.advanceTimersByTimeAsync(0);expect(f.store.put).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });
});
