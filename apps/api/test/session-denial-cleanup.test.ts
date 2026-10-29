import {describe,it,expect,vi} from 'vitest';
import {persistSessionDenial} from '../src/session-denial';
import {sweepSessionDenials,cleanupDeniedSessions} from '../src/session-denial-cleanup';
import type {Env} from '../src/types';
import {denialProgressKey as cursorKey,parseDenialProgress,denialProgressHealth,readDenialCleanupHealth} from '../src/session-denial-progress';
const id=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
async function fixture(count=1){
 const rows=new Map<string,{etag:string;text:string}>(),sqlRows=new Set<string>();let version=0;
 const store={
  get:vi.fn(async(key:string)=>{const row=rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}),
  put:vi.fn(async(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}})=>{
   const old=rows.get(key),condition=options?.onlyIf;
   if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
   const etag=String(++version);rows.set(key,{etag,text});return {etag};
  }),
  list:vi.fn(async(options:{prefix:string;limit:number;cursor?:string})=>{
   const keys=[...rows.keys()].filter(k=>k.startsWith(options.prefix)&&(!options.cursor||k>options.cursor)).sort();
   return {objects:keys.slice(0,options.limit).map(key=>({key})),truncated:keys.length>options.limit,...(keys.length>options.limit?{cursor:keys[options.limit-1]}:{})};
  }),
 };
 for(let i=1;i<=count;i++){await persistSessionDenial(store,id(i));sqlRows.add(id(i));}
 store.put.mockClear();store.get.mockClear();
 const cleanup=vi.fn(async(sessionId:string)=>sqlRows.delete(sessionId));
 return {store,rows,sqlRows,cleanup};
}
describe('durable denial cleanup discovery',()=>{
 it('deletes only verified denied rows, retains denials and never changes global privacy control',async()=>{
  const f=await fixture(2);f.sqlRows.add(id(3));f.rows.set('control.json',{etag:'private',text:'unchanged'});
  expect(await sweepSessionDenials(f.store,f.cleanup)).toEqual({seen:2,deleted:2,invalid:0,advanced:false});
  expect([...f.sqlRows]).toEqual([id(3)]);expect(f.rows.size).toBe(4);expect(f.rows.get('control.json')?.text).toBe('unchanged');expect(f.store.put).toHaveBeenCalledTimes(1);
  f.sqlRows.add(id(1));expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(1); // restored SQL row
 });
 it('advances at most 10 records and wraps to discover records inserted before the old cursor',async()=>{
  const f=await fixture(16),first=[...f.rows.keys()].sort()[0],record=f.rows.get(first)!;f.rows.delete(first);
  expect((await sweepSessionDenials(f.store,f.cleanup)).seen).toBe(10);expect(f.rows.has(cursorKey)).toBe(true);
  f.rows.set(first,record);
  expect((await sweepSessionDenials(f.store,f.cleanup)).seen).toBe(5);expect(f.sqlRows.size).toBe(1);
  expect(JSON.parse(f.rows.get(cursorKey)!.text).cursor).toBeNull();
  await sweepSessionDenials(f.store,f.cleanup);expect(f.sqlRows.size).toBe(0);
 });
 it('repeats a page after an unknown SQL commit without replaying any broader operation',async()=>{
  const f=await fixture(11);f.cleanup.mockImplementationOnce(async sessionId=>{f.sqlRows.delete(sessionId);throw Error('lost commit acknowledgement');});
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow();expect(f.rows.has(cursorKey)).toBe(false);expect(f.sqlRows.size).toBe(10);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(9);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(1);expect(f.sqlRows.size).toBe(0);
 });
 it('repeats completed deletions if the cursor write fails, without losing discovery',async()=>{
  const f=await fixture(11);f.store.put.mockRejectedValueOnce(Error('private transport error'));
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');expect(f.rows.has(cursorKey)).toBe(false);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(0);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(1);expect(f.sqlRows.size).toBe(0);
 });
 it('continues from committed progress after losing the cursor acknowledgement',async()=>{
  const f=await fixture(11),put=f.store.put.getMockImplementation()!;
  f.store.put.mockImplementationOnce(async(...args)=>{await put(...args);throw Error('lost cursor reply');});
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');expect(f.rows.has(cursorKey)).toBe(true);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(1);expect(f.sqlRows.size).toBe(0);
 });
 it('rejects corrupt progress without treating it as cleanup authority',async()=>{
  const f=await fixture();f.rows.set(cursorKey,{etag:'bad',text:'{"v":1,"cursor":null}'});
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');expect(f.store.list).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled();
 });
 it('does not overwrite another worker cursor after overlapping idempotent sweeps',async()=>{
  const f=await fixture(11),results=await Promise.all([sweepSessionDenials(f.store,f.cleanup),sweepSessionDenials(f.store,f.cleanup)]);
  expect(results.map(r=>r.advanced).sort()).toEqual([false,true]);expect(f.sqlRows.size).toBe(1);
  await sweepSessionDenials(f.store,f.cleanup);expect(f.sqlRows.size).toBe(0);
 });
 it('rejects body/key mismatches without starving valid records behind a corrupt record',async()=>{
  const f=await fixture(11),keys=[...f.rows.keys()].sort();f.rows.get(keys[0])!.text=f.rows.get(keys[1])!.text;
  const result=await sweepSessionDenials(f.store,f.cleanup);expect(result.invalid).toBe(1);expect(result.deleted).toBe(9);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(1);expect(f.sqlRows.size).toBe(1);
 });
 it('does not advance after a listed immutable record disappears',async()=>{
  const f=await fixture();f.store.get.mockResolvedValue(null);
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');expect(f.cleanup).not.toHaveBeenCalled();expect(f.store.put).not.toHaveBeenCalled();
 });
 it('bounds a stalled listing and cannot clean up after its deadline',async()=>{
  const f=await fixture();vi.useFakeTimers();
  try{
   f.store.list.mockImplementation(()=>new Promise(()=>{}));const pending=sweepSessionDenials(f.store,f.cleanup);
   const verdict=expect(pending).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');await vi.advanceTimersByTimeAsync(2000);await verdict;
   expect(f.cleanup).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });
 it('is disabled by default and requires independent storage when enabled',async()=>{
  expect(await cleanupDeniedSessions({} as Env)).toEqual({seen:0,deleted:0,invalid:0,advanced:false});
  await expect(cleanupDeniedSessions({SESSION_DENIAL_CLEANUP_V1:'true'} as Env)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
 });
});

describe('independent denial cleanup progress',()=>{
 const epoch=Date.UTC(2026,9,29);
 const health=(f:Awaited<ReturnType<typeof fixture>>)=>readDenialCleanupHealth({SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:f.store} as unknown as Env);
 it('records actual empty scans and starts a separate cursor without altering rollback progress',async()=>{
  const f=await fixture(0),old='session-denial-maintenance/v1/cursor.json';
  f.rows.set(old,{etag:'old',text:'{"v":1,"cursor":"old-position"}'});
  expect((await health(f)).issues).toEqual(['session_denial_cleanup_missing']);
  await sweepSessionDenials(f.store,f.cleanup);
  expect((await health(f)).issues).toEqual([]);
  expect(parseDenialProgress(f.rows.get(cursorKey)!.text).lastPass?.seen).toBe(0);
  expect(f.rows.get(old)).toEqual({etag:'old',text:'{"v":1,"cursor":"old-position"}'});
  expect(f.cleanup).not.toHaveBeenCalled();
 });
 it('distinguishes fresh pages, unfinished passes, stalled pages and stale completed passes',async()=>{
  const f=await fixture(11);vi.useFakeTimers();vi.setSystemTime(epoch);
  try{
   await sweepSessionDenials(f.store,f.cleanup);
   expect((await health(f)).issues).toEqual(['session_denial_pass_stale']);
   vi.setSystemTime(epoch+60000);await sweepSessionDenials(f.store,f.cleanup);
   const result=await health(f);expect(result.issues).toEqual([]);
   expect(result.snapshot).toMatchObject({last_pass_seen:11,last_pass_duration_seconds:60,current_pass_seen:0});
   expect(JSON.stringify(result)).not.toMatch(/cursor|11111111|session-denials/);
   vi.setSystemTime(epoch+240001);expect((await health(f)).issues).toEqual(['session_denial_cleanup_stale']);
   vi.setSystemTime(epoch+360001);expect((await health(f)).issues).toEqual(['session_denial_cleanup_stale','session_denial_pass_stale']);
   await sweepSessionDenials(f.store,f.cleanup);await sweepSessionDenials(f.store,f.cleanup);
   expect((await health(f)).issues).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it('reports slow completed passes even immediately after a fresh page',async()=>{
  const f=await fixture(11);vi.useFakeTimers();vi.setSystemTime(epoch);
  try{
   await sweepSessionDenials(f.store,f.cleanup);vi.setSystemTime(epoch+300001);
   expect((await health(f)).issues).toContain('session_denial_pass_slow');
   await sweepSessionDenials(f.store,f.cleanup);
   expect((await health(f)).issues).toEqual(['session_denial_pass_slow']);
  }finally{vi.useRealTimers();}
 });
 it('retains invalid-record health until an entire clean pass completes',async()=>{
  const f=await fixture(11),key=[...f.rows.keys()].sort()[0],original=f.rows.get(key)!.text;f.rows.get(key)!.text='invalid';
  await sweepSessionDenials(f.store,f.cleanup);expect((await health(f)).issues).toContain('session_denial_cleanup_invalid');
  await sweepSessionDenials(f.store,f.cleanup);expect((await health(f)).issues).toContain('session_denial_cleanup_invalid');
  f.rows.get(key)!.text=original;
  await sweepSessionDenials(f.store,f.cleanup);expect((await health(f)).issues).toContain('session_denial_cleanup_invalid');
  await sweepSessionDenials(f.store,f.cleanup);expect((await health(f)).issues).toEqual([]);
 });
 it('does not refresh health after failed SQL; a later successful sweep recovers',async()=>{
  const f=await fixture();vi.useFakeTimers();vi.setSystemTime(epoch);
  try{
   await sweepSessionDenials(f.store,f.cleanup);const before=f.rows.get(cursorKey)!.text;
   vi.setSystemTime(epoch+180001);f.cleanup.mockRejectedValueOnce(Error('unknown commit'));
   await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow();
   expect(f.rows.get(cursorKey)!.text).toBe(before);expect((await health(f)).issues).toEqual(['session_denial_cleanup_stale']);
   await sweepSessionDenials(f.store,f.cleanup);expect((await health(f)).issues).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it('a delayed concurrent worker cannot overwrite the winning cursor or heartbeat',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const slow=sweepSessionDenials(f.store,async()=>{entered();await gate;return false;});
  try{await started;await sweepSessionDenials(f.store,f.cleanup);const winner=f.rows.get(cursorKey);
   release();await slow;expect(f.rows.get(cursorKey)).toEqual(winner);
  }finally{release();await slow;}
 });
 it('a lost progress acknowledgement can commit real progress without replaying SQL work',async()=>{
  const f=await fixture(),put=f.store.put.getMockImplementation()!;
  f.store.put.mockImplementationOnce(async(...args)=>{await put(...args);throw Error('reply lost');});
  await expect(sweepSessionDenials(f.store,f.cleanup)).rejects.toThrow();
  expect((await health(f)).issues).toEqual([]);expect(f.sqlRows.size).toBe(0);
  expect((await sweepSessionDenials(f.store,f.cleanup)).deleted).toBe(0);
 });
 it('disabled monitoring reads nothing; missing, malformed and future state cannot appear healthy',async()=>{
  const f=await fixture();expect(await readDenialCleanupHealth({RECOVERY_JOURNAL:f.store} as unknown as Env)).toEqual({issues:[],snapshot:null});expect(f.store.get).not.toHaveBeenCalled();
  expect((await readDenialCleanupHealth({SESSION_DENIAL_CLEANUP_V1:'true'} as Env)).issues).toEqual(['session_denial_cleanup_unavailable']);
  f.rows.set(cursorKey,{etag:'bad',text:'{"v":1,"cursor":null}'});expect((await health(f)).issues).toEqual(['session_denial_cleanup_unavailable']);
  f.rows.delete(cursorKey);await sweepSessionDenials(f.store,f.cleanup);const progress=parseDenialProgress(f.rows.get(cursorKey)!.text);
  expect(()=>denialProgressHealth(progress,progress.pageCompletedAt-1)).toThrow();
  const malformed={...progress,passSeen:1};f.rows.set(cursorKey,{etag:'bad',text:JSON.stringify(malformed)});
  expect((await health(f)).issues).toEqual(['session_denial_cleanup_unavailable']);
 });
 it('bounds a stalled health body without writes or a lingering timer',async()=>{
  const f=await fixture();f.store.get.mockResolvedValue({etag:'held',text:()=>new Promise<string>(()=>{})});vi.useFakeTimers();
  try{const pending=health(f);await vi.advanceTimersByTimeAsync(2000);expect((await pending).issues).toEqual(['session_denial_cleanup_unavailable']);expect(f.store.put).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
  finally{vi.useRealTimers();}
 });
});
