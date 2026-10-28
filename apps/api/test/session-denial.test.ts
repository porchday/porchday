import {describe,it,expect,vi} from 'vitest';
import {persistSessionDenial,sessionDenied,runtimeSessionDenied,publishSessionDenial} from '../src/session-denial';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
function storage(){
 const rows=new Map<string,string>();let fail:'none'|'before'|'after'='none';
 const put=vi.fn(async(key:string,text:string,options?:{onlyIf?:{etagDoesNotMatch?:string}})=>{
  expect(options).toEqual({onlyIf:{etagDoesNotMatch:'*'}});
  if(fail==='before')throw Error('private provider credential');
  if(rows.has(key))return null;
  rows.set(key,text);
  if(fail==='after')throw Error('private provider credential');
  return {etag:'stored'};
 });
 const get=vi.fn(async(key:string)=>rows.has(key)?{etag:'stored',text:async()=>rows.get(key)!}:null);
 return {rows,put,get,setFailure:(value:typeof fail)=>{fail=value;}};
}
describe('Independent session denial storage (not live authentication integration)',()=>{
 it('publishes one immutable session denial without touching global control or another session',async()=>{
  const s=storage();s.rows.set('control.json','unchanged');
  await persistSessionDenial(s,first);
  expect(await sessionDenied(s,first)).toBe(true);expect(await sessionDenied(s,second)).toBe(false);
  expect(s.rows.get('control.json')).toBe('unchanged');expect(s.put).toHaveBeenCalledTimes(1);
  expect(s.put.mock.calls[0][0]).toMatch(/^session-denials\/v1\/[a-f0-9]{64}\.json$/);
  expect(s.put.mock.calls[0][0]).not.toContain(first);
 });
 it('reconciles a committed write with a lost reply without replaying it',async()=>{
  const s=storage();s.setFailure('after');await persistSessionDenial(s,first);
  expect(s.put).toHaveBeenCalledTimes(1);expect(s.get).toHaveBeenCalledTimes(1);expect(await sessionDenied(s,first)).toBe(true);
 });
 it('refuses to claim denial after an uncommitted failure',async()=>{
  const s=storage();s.setFailure('before');await expect(persistSessionDenial(s,first)).rejects.toThrow('SESSION_DENIAL_UNCONFIRMED');
  expect(s.put).toHaveBeenCalledTimes(1);expect(await sessionDenied(s,first)).toBe(false);
 });
 it('does not treat a negative reconciliation read as proof that an unknown write cannot commit later',async()=>{
  const s=storage();let late:()=>void=()=>{};
  s.put.mockImplementationOnce(async(key,text)=>{late=()=>{s.rows.set(key,text);};throw Error('lost in-flight response');});
  await expect(persistSessionDenial(s,first)).rejects.toThrow('SESSION_DENIAL_UNCONFIRMED');
  expect(s.put).toHaveBeenCalledTimes(1);expect(await sessionDenied(s,first)).toBe(false);
  late();expect(await sessionDenied(s,first)).toBe(true);
 });
 it('is idempotent under simultaneous writes and later retries',async()=>{
  const s=storage();await Promise.all([persistSessionDenial(s,first),persistSessionDenial(s,first)]);
  const before=[...s.rows];await persistSessionDenial(s,first);
  expect([...s.rows]).toEqual(before);expect(s.rows.size).toBe(1);
 });
 it('preserves a committed denial when its acknowledgement and reconciliation read both fail',async()=>{
  const s=storage();s.setFailure('after');s.get.mockRejectedValueOnce(Error('private network details'));
  await expect(persistSessionDenial(s,first)).rejects.toThrow('SESSION_DENIAL_READ_FAILED');
  expect(s.put).toHaveBeenCalledTimes(1);expect(await sessionDenied(s,first)).toBe(true);
 });
 it('fails closed on read or body transport errors, without disclosing their details',async()=>{
  const s=storage();s.get.mockRejectedValueOnce(Error('private token'));
  await expect(sessionDenied(s,first)).rejects.toThrow('SESSION_DENIAL_READ_FAILED');
  s.get.mockResolvedValueOnce({etag:'x',text:async()=>{throw Error('private body');}});
  await expect(sessionDenied(s,first)).rejects.toThrow('SESSION_DENIAL_READ_FAILED');
 });
 it.each(['{}','null','private malformed body',JSON.stringify({v:1,kind:'session-denial',sessionId:second})])('never accepts or overwrites a conflicting entry (%#)',async text=>{
  const s=storage();await persistSessionDenial(s,first);const key=[...s.rows.keys()][0];s.rows.set(key,text);
  await expect(sessionDenied(s,first)).rejects.toThrow('SESSION_DENIAL_INVALID');
  await expect(persistSessionDenial(s,first)).rejects.toThrow('SESSION_DENIAL_INVALID');expect(s.rows.get(key)).toBe(text);
 });
 it.each(['', 'Bearer private-token', '../control.json','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',first+'?token=private',undefined])('rejects unvalidated identifiers before accessing storage (%#)',async value=>{
  const s=storage();await expect(persistSessionDenial(s,value as string)).rejects.toThrow('SESSION_DENIAL_ID_INVALID');
  await expect(sessionDenied(s,value as string)).rejects.toThrow('SESSION_DENIAL_ID_INVALID');expect(s.put).not.toHaveBeenCalled();expect(s.get).not.toHaveBeenCalled();
 });
 it('models process loss before SQL cleanup and restoration of the old SQL row',async()=>{
  const s=storage();const sqlRows=new Set([first,second]);
  const guarded=async(id:string)=>sqlRows.has(id)&&!await sessionDenied(s,id);
  await persistSessionDenial(s,first); // crash here: SQL still contains the session
  expect(sqlRows.has(first)).toBe(true);expect(await guarded(first)).toBe(false);expect(await guarded(second)).toBe(true);
  sqlRows.delete(first);sqlRows.add(first); // restore an older SQL snapshot
  expect(await guarded(first)).toBe(false);expect(await guarded(second)).toBe(true);
  // This model proves only storage independence. Real HTTP/push/restore paths
  // must be integrated and exercised before any writer may be enabled.
 });
});

describe('bounded runtime denial reads',()=>{
 it.each(['lookup','body'])('rejects a stalled %s within 2s and never accepts a late result',async phase=>{
  vi.useFakeTimers();
  try{
   let finish!:(value:null)=>void;
   const stalled=new Promise<null>(resolve=>{finish=resolve;});
   const store={get:async()=>phase==='lookup'?stalled:{etag:'x',text:async()=>{await stalled;return '{}';}}};
   const pending=runtimeSessionDenied({ENVIRONMENT:'production',RECOVERY_JOURNAL:store as unknown as R2Bucket},first);
   const verdict=expect(pending).rejects.toThrow('SESSION_DENIAL_READ_FAILED');
   await vi.advanceTimersByTimeAsync(2000);await verdict;
   finish(null);await vi.runAllTimersAsync();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });
 it('clears the deadline after an ordinary negative lookup',async()=>{
  vi.useFakeTimers();
  try{
   expect(await runtimeSessionDenied({ENVIRONMENT:'production',RECOVERY_JOURNAL:{get:async()=>null} as unknown as R2Bucket},first)).toBe(false);
   expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });
});

describe('bounded denial publication',()=>{
 it('never proceeds to cleanup after a timeout, even if the immutable write commits later',async()=>{
  const s=storage(),cleanup=vi.fn();let finish!:()=>void;vi.useFakeTimers();
  try{
   s.put.mockImplementationOnce(async(key,text)=>{await new Promise<void>(resolve=>{finish=resolve;});s.rows.set(key,text);return {etag:'stored'};});
   const operation=publishSessionDenial({RECOVERY_JOURNAL:s as unknown as R2Bucket},first).then(cleanup);
   const verdict=expect(operation).rejects.toThrow('SESSION_DENIAL_UNCONFIRMED');
   await vi.waitFor(()=>expect(s.put).toHaveBeenCalledTimes(1));await vi.advanceTimersByTimeAsync(4000);await verdict;
   expect(cleanup).not.toHaveBeenCalled();finish();await vi.runAllTimersAsync();
   expect(await sessionDenied(s,first)).toBe(true);expect(cleanup).not.toHaveBeenCalled();expect(s.put).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });
 it('requires independent storage, including in development',async()=>{
  await expect(publishSessionDenial({},first)).rejects.toThrow('SESSION_DENIAL_NOT_CONFIGURED');
 });
});
