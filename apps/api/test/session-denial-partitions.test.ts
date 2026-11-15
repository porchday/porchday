import {describe,it,expect,vi} from 'vitest';
import {candidateProgressKey,parseCandidateProgress,sweepSessionCandidates} from '../src/session-denial-candidates';
import {denialPartitions,partitionProgressKey,parsePartitionProgress,partitionStore,partitionCleanupHealth,listPartitionCandidates,type PartitionProgress} from '../src/session-denial-partitions';
import type {Pool} from 'pg';
import {persistSessionDenial} from '../src/session-denial';
const id='11111111-1111-4111-8111-111111111111';
function fixture(){
 const records=new Map<string,{text:string;etag:string}>();let version=0;
 const store={get:vi.fn(async(key:string)=>{const row=records.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}),put:vi.fn(async(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}})=>{
  const old=records.get(key),condition=options?.onlyIf;if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
  const etag=String(++version);records.set(key,{text,etag});return {etag};
 })};return{records,store};
}
function progress(partition:0|1|2,at=1000000):PartitionProgress{return {v:4,strategy:'sql-session-ranges',partition,cursor:null,pageCompletedAt:at,passStartedAt:null,passSeen:0,passInvalid:0,lastPass:{completedAt:at,durationMs:1000,seen:100,invalid:0}};}
describe('isolated session scan partitions',()=>{
 it('writes three independent checkpoints without touching legacy v3 evidence',async()=>{
  const f=fixture();f.records.set(candidateProgressKey,{text:'legacy sentinel',etag:'legacy'});
  for(const partition of denialPartitions){const scoped=partitionStore(f.store,partition);expect(await sweepSessionCandidates(scoped,async()=>({ids:[],more:false}),vi.fn())).toMatchObject({seen:0,deleted:0});expect(parsePartitionProgress(f.records.get(partitionProgressKey(partition))!.text,partition).lastPass?.seen).toBe(0);expect(parseCandidateProgress(await(await scoped.get(candidateProgressKey))!.text()).v).toBe(3);}
  expect(f.records.get(candidateProgressKey)).toEqual({text:'legacy sentinel',etag:'legacy'});expect(f.records.size).toBe(4);
 });
 it('keeps immutable authority exact and does not grant arbitrary reads or writes',async()=>{
  const f=fixture();await persistSessionDenial(f.store,id);const scoped=partitionStore(f.store,0),cleanup=vi.fn(async()=>true);
  expect(await sweepSessionCandidates(scoped,async()=>({ids:[id],more:false}),cleanup)).toMatchObject({seen:1,deleted:1});expect(cleanup).toHaveBeenCalledExactlyOnceWith(id);
  await expect(scoped.get('control.json')).rejects.toThrow();await expect(scoped.put('session-denials/v1/'+'a'.repeat(64)+'.json','bad')).rejects.toThrow();
 });
 it('rejects cross-partition and legacy bodies rather than accepting a fresh timestamp',()=>{
  for(const value of [{...progress(0),partition:1},{...progress(0),v:3},{...progress(0),strategy:'sql-session-keyset'},{...progress(0),extra:true}])expect(()=>parsePartitionProgress(JSON.stringify(value),0)).toThrow();
  expect(()=>partitionProgressKey(3 as 0)).toThrow();
 });
 it('keeps a losing CAS from advancing or enqueueing another partition',async()=>{
  const f=fixture(),scoped=partitionStore(f.store,0);await sweepSessionCandidates(scoped,async()=>({ids:[],more:false}),vi.fn());
  const old=await scoped.get(candidateProgressKey),text=await old!.text();const winner=await scoped.put(candidateProgressKey,text,{onlyIf:{etagMatches:old!.etag}});
  expect(winner).toBeTruthy();expect(await scoped.put(candidateProgressKey,text,{onlyIf:{etagMatches:old!.etag}})).toBeNull();
  expect(await sweepSessionCandidates(scoped,vi.fn(),vi.fn(),old!.etag)).toEqual({seen:0,deleted:0,invalid:0,advanced:false});expect(f.records.has(partitionProgressKey(1))).toBe(false);
 });
 it('reconciles a persisted checkpoint with a lost reply without rewriting another namespace',async()=>{
  const f=fixture(),put=f.store.put.getMockImplementation()!;f.store.put.mockImplementationOnce(async(...args)=>{await put(...args);throw Error('lost successful reply');});
  await expect(sweepSessionCandidates(partitionStore(f.store,1),async()=>({ids:[],more:false}),vi.fn())).rejects.toThrow();
  expect(parsePartitionProgress(f.records.get(partitionProgressKey(1))!.text,1).lastPass?.seen).toBe(0);expect(f.records.size).toBe(1);
  expect(await sweepSessionCandidates(partitionStore(f.store,1),async()=>({ids:[],more:false}),vi.fn())).toMatchObject({seen:0});
 });
 it('uses the oldest range and preserves every existing health limit',()=>{
  const values=denialPartitions.map(p=>progress(p));expect(partitionCleanupHealth(values,1001000)).toMatchObject({issues:[],snapshot:{pass_age_seconds:1,last_pass_seen:300}});
  values[1]=progress(1,600000);expect(partitionCleanupHealth(values,1001000).issues).toContain('session_denial_pass_stale');expect(partitionCleanupHealth(values,1001000).snapshot?.pass_age_seconds).toBe(401);
  expect(partitionCleanupHealth([values[0],null,values[2]],1001000)).toEqual({issues:['session_denial_cleanup_missing'],snapshot:null});
 });
 it('rejects duplicated, malformed or future range evidence and reports slow or invalid ranges',()=>{
  const values=denialPartitions.map(p=>progress(p));expect(()=>partitionCleanupHealth([values[0],values[0],values[2]],1001000)).toThrow();expect(()=>partitionCleanupHealth(values,999999)).toThrow();expect(()=>partitionCleanupHealth(values.slice(0,2))).toThrow();
  values[2].lastPass!.durationMs=300001;values[2].lastPass!.invalid=1;const result=partitionCleanupHealth(values,1001000);expect(result.issues).toEqual(['session_denial_pass_slow','session_denial_cleanup_invalid']);expect(result.snapshot?.invalid_records).toBe(1);
 });
 it('never treats an unfinished initial range as a completed global pass',()=>{
  const values=denialPartitions.map(p=>progress(p));values[0]={...values[0],cursor:id,passStartedAt:999000,passSeen:50,lastPass:null};
  expect(partitionCleanupHealth(values,1001000)).toMatchObject({issues:['session_denial_pass_stale'],snapshot:{pass_age_seconds:null,last_pass_seen:null,current_pass_seen:50}});
 });
 it('rejects invalid partition and cursor inputs before connecting to SQL',async()=>{
  const connect=vi.fn(),pool={connect} as unknown as Pool;await expect(listPartitionCandidates(pool,9 as 0,null)).rejects.toThrow();await expect(listPartitionCandidates(pool,0,'')).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
 });
});
