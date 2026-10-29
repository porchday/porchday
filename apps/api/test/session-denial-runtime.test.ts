import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '../src/types';
const mocks=vi.hoisted(()=>({pool:vi.fn(),end:vi.fn(),drain:vi.fn()}));
vi.mock('pg',async original=>({...await original<typeof import('pg')>(),Pool:class{on=vi.fn();end=mocks.end;constructor(config:unknown){mocks.pool(config);}}}));
vi.mock('../src/session-denial-candidates',async original=>({...await original<typeof import('../src/session-denial-candidates')>(),drainSessionCandidates:mocks.drain}));
import {denialCleanupMode,scheduleDenialCleanup,enqueuePartitionContinuation,cleanupDenialPartition,readManagedDenialCleanupHealth} from '../src/session-denial-runtime';
import {partitionProgressKey} from '../src/session-denial-partitions';
import {candidateProgressKey} from '../src/session-denial-candidates';
beforeEach(()=>{vi.clearAllMocks();mocks.end.mockResolvedValue(undefined);mocks.drain.mockResolvedValue({seen:0,deleted:0,invalid:0,advanced:false});});
const env=(mode='active')=>({SESSION_DENIAL_CLEANUP_V1:'true',SESSION_DENIAL_PARTITIONS_V1:mode,HYPERDRIVE_AUTH:{connectionString:'postgres://not-connected'},RECOVERY_JOURNAL:{get:vi.fn(),put:vi.fn()},JOBS:{send:vi.fn(async()=>{})}} as unknown as Env);
function record(partition:number,age=0){const at=Date.now()-age;return{v:4,strategy:'sql-session-ranges',partition,cursor:null,pageCompletedAt:at,passStartedAt:null,passSeen:0,passInvalid:0,lastPass:{completedAt:at,durationMs:1,seen:100,invalid:0}};}
describe('partition cleanup runtime admission and modes',()=>{
 it('defaults to legacy behavior and rejects invalid/inconsistent opt-ins',()=>{
  expect(denialCleanupMode({})).toBe('disabled');for(const value of ['true','ACTIVE','', 'shadow','active'])expect(()=>denialCleanupMode({SESSION_DENIAL_PARTITIONS_V1:value})).toThrow();
  expect(denialCleanupMode(env('shadow'))).toBe('shadow');expect(denialCleanupMode(env())).toBe('active');
 });
 it.each(['disabled','shadow','active'])('schedules only the fixed jobs for %s',async mode=>{
  const e=env(mode);await scheduleDenialCleanup(e);const jobs=vi.mocked(e.JOBS.send).mock.calls.map(call=>call[0]);
  expect(jobs).toEqual([...(mode!=='active'?[{kind:'session_denial_cleanup'}]:[]),...(mode!=='disabled'?[0,1,2].map(denialPartition=>({kind:'session_denial_cleanup_partition',denialPartition})):[])]);
 });
 it('does not fan out when cleanup is disabled and settles every attempted send on failure',async()=>{
  const e=env('disabled');e.SESSION_DENIAL_CLEANUP_V1=undefined;await scheduleDenialCleanup(e);expect(e.JOBS.send).not.toHaveBeenCalled();
  const active=env(),send=vi.mocked(active.JOBS.send);send.mockRejectedValueOnce(Error('lost send'));await expect(scheduleDenialCleanup(active)).rejects.toThrow();expect(send).toHaveBeenCalledTimes(3);
 });
 it('bounds stalled sends without replaying them after a late reply',async()=>{
  vi.useFakeTimers();const e=env();let release!:()=>void;vi.mocked(e.JOBS.send).mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  try{const pending=enqueuePartitionContinuation(e,1,'v4:1:etag'),failure=expect(pending).rejects.toThrow();await vi.advanceTimersByTimeAsync(5000);await failure;release();await vi.advanceTimersByTimeAsync(0);expect(e.JOBS.send).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);}finally{release?.();vi.useRealTimers();}
 });
 it('binds continuation tokens to their range and rejects cross-range tokens before SQL',async()=>{
  const e=env();await expect(cleanupDenialPartition(e,1,'v4:0:etag')).rejects.toThrow();await expect(cleanupDenialPartition(e,3)).rejects.toThrow();await expect(cleanupDenialPartition(e,0,'v4:0:')).rejects.toThrow();expect(mocks.pool).not.toHaveBeenCalled();
  await expect(enqueuePartitionContinuation(e,0,'v4:1:etag')).rejects.toThrow();expect(e.JOBS.send).not.toHaveBeenCalled();
 });
 it('uses one invocation-local connection, unwraps the scoped token, and closes the pool',async()=>{
  mocks.drain.mockResolvedValueOnce({seen:100,deleted:2,invalid:0,advanced:true,continuation:'new'});const result=await cleanupDenialPartition(env(),2,'v4:2:old');
  expect(mocks.pool).toHaveBeenCalledExactlyOnceWith({connectionString:'postgres://not-connected',max:1,connectionTimeoutMillis:10000,idleTimeoutMillis:1000});expect(mocks.drain.mock.calls[0][3]).toBe('old');expect(result.continuation).toBe('v4:2:new');expect(mocks.end).toHaveBeenCalledTimes(1);
 });
 it('closes SQL on failure and leaves failed/stale work without a continuation',async()=>{
  mocks.drain.mockRejectedValueOnce(Error('unknown SQL commit'));await expect(cleanupDenialPartition(env(),0)).rejects.toThrow();expect(mocks.end).toHaveBeenCalledTimes(1);
  expect((await cleanupDenialPartition(env(),0,'v4:0:stale')).continuation).toBeUndefined();expect(mocks.end).toHaveBeenCalledTimes(2);
 });
 it('drains disabled-mode deliveries without opening SQL or sending continuations',async()=>{
  expect(await cleanupDenialPartition(env('disabled'),2,'v4:2:old')).toEqual({seen:0,deleted:0,invalid:0,advanced:false});expect(mocks.pool).not.toHaveBeenCalled();const e=env('disabled');await enqueuePartitionContinuation(e,2,'v4:2:old');expect(e.JOBS.send).not.toHaveBeenCalled();
 });
 it('reads all active range health and never accepts the fresh legacy checkpoint as a fallback',async()=>{
  const e=env(),get=vi.fn(async(key:string)=>{const partition=[0,1,2].find(p=>partitionProgressKey(p)===key);if(partition===undefined)throw Error('legacy read');return{etag:'e',text:async()=>JSON.stringify(record(partition,partition===1?301000:0))};});e.RECOVERY_JOURNAL={get} as never;
  const result=await readManagedDenialCleanupHealth(e);expect(get).toHaveBeenCalledTimes(3);expect(result.issues).toContain('session_denial_pass_stale');expect(result.snapshot?.pass_age_seconds).toBe(301);expect(get).not.toHaveBeenCalledWith(candidateProgressKey);
  get.mockResolvedValueOnce(null as never);expect((await readManagedDenialCleanupHealth(e)).issues).toEqual(['session_denial_cleanup_missing']);
 });
 it('keeps shadow readiness on v3 during initialization, and rejects bad mode configuration',async()=>{
  const e=env('shadow'),get=vi.fn(async(key:string)=>{expect(key).toBe(candidateProgressKey);const{partition:_,...value}=record(0);return{etag:'e',text:async()=>JSON.stringify({...value,v:3,strategy:'sql-session-keyset'})};});e.RECOVERY_JOURNAL={get} as never;
  expect((await readManagedDenialCleanupHealth(e)).issues).toEqual([]);expect(get).toHaveBeenCalledTimes(1);
  expect((await readManagedDenialCleanupHealth(env('invalid'))).issues).toEqual(['session_denial_cleanup_unavailable']);
 });
 it('bounds aggregate active health even if one shard stalls forever',async()=>{
  const e=env();e.RECOVERY_JOURNAL={get:vi.fn(()=>new Promise(()=>{}))} as never;vi.useFakeTimers();try{const pending=readManagedDenialCleanupHealth(e);await vi.advanceTimersByTimeAsync(2000);expect(await pending).toEqual({issues:['session_denial_cleanup_unavailable'],snapshot:null});expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
 });
});
