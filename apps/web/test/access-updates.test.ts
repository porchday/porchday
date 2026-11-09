import {describe,it,expect,vi} from 'vitest';
import {startAccessUpdates} from '../src/access-updates';
import {ApiError} from '../src/api';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture(){
 let clock=0,online=true;const completed=new Set<string>();
 const io={enabled:()=>online,now:()=>clock,list:vi.fn(async()=>({items:['a','b','c','d'].filter(id=>!completed.has(id)).map(id=>({id}))})),
 prepare:vi.fn(async(id:string,_signal:AbortSignal):Promise<{id:string;bytes:string}|null>=>({id,bytes:'encrypted-'+id})),
 save:vi.fn(async(candidate:{id:string;bytes:string})=>{completed.add(candidate.id);}),
 reconcile:vi.fn(async()=> 'unchanged' as 'unchanged'|'committed'|'changed'),cleanup:vi.fn(async()=>{}),state:vi.fn(),changed:vi.fn()};
 return {io,completed,advance:(ms:number)=>{clock+=ms;},online:(value:boolean)=>{online=value;}};
}
describe('automatic access updates',()=>{
 it('drains every listed photo before advancing the cursor despite repeated earlier failures',async()=>{
  const f=fixture();
  f.io.list.mockResolvedValueOnce({items:['a','b','c','d','e'].map(id=>({id}))}).mockResolvedValue({items:[{id:'f'}]});
  f.io.prepare.mockImplementation(async id=>{if(['a','b','c'].includes(id))throw Error('missing old key');return {id,bytes:'encrypted'};});
  const task=startAccessUpdates(f.io);await flush();
  expect(f.completed.size).toBe(0);
  f.advance(300001);await task.recheck();
  expect([...f.completed]).toEqual(['d','e']);
  expect(f.io.list).toHaveBeenCalledTimes(1);
  await task.recheck();expect(f.completed.has('f')).toBe(true);task.dispose();
 });
 it('retries temporary preparation failures without blocking other items',async()=>{
  const f=fixture();f.io.prepare.mockRejectedValueOnce(Error('temporary read failure'));
  const task=startAccessUpdates(f.io);await flush();
  expect([...f.completed]).toEqual(['b','c']);expect(f.io.state).toHaveBeenLastCalledWith('unconfirmed');
  await task.recheck();expect([...f.completed]).toEqual(['b','c','d']);
  f.advance(5001);await task.recheck();expect(f.completed.has('a')).toBe(true);
  expect(f.io.state).toHaveBeenLastCalledWith('idle');task.dispose();
 });
 it('backs off list failures and resumes on automatic checks',async()=>{
  const f=fixture();f.io.list.mockRejectedValueOnce(Error('offline'));
  const task=startAccessUpdates(f.io);await flush();await task.recheck();expect(f.io.list).toHaveBeenCalledTimes(1);
  f.advance(5001);await task.recheck();expect(f.completed.size).toBe(3);task.dispose();
 });
 it('retains uncertain ciphertext when reconciliation fails and never uploads it again',async()=>{
  const f=fixture();f.io.list.mockResolvedValue({items:[{id:'a'}]});
  f.io.save.mockRejectedValueOnce(Error('response lost'));f.io.reconcile.mockRejectedValueOnce(Error('read offline'));
  const task=startAccessUpdates(f.io);await flush();const original=f.io.save.mock.calls[0][0];
  f.io.list.mockResolvedValue({items:[]});f.advance(5001);await task.recheck();
  expect(f.io.prepare).toHaveBeenCalledTimes(1);expect(f.io.save.mock.calls[1][0]).toBe(original);expect(f.io.cleanup).not.toHaveBeenCalled();task.dispose();
 });
 it('recognizes a lost-response commit later without resubmission',async()=>{
  const f=fixture();f.io.list.mockResolvedValue({items:[{id:'a'}]});f.io.save.mockRejectedValueOnce(Error('lost'));
  f.io.reconcile.mockRejectedValueOnce(Error('read lost')).mockResolvedValue('committed');
  const task=startAccessUpdates(f.io);await flush();f.io.list.mockResolvedValue({items:[]});f.advance(5001);await task.recheck();
  expect(f.io.save).toHaveBeenCalledTimes(1);expect(f.io.changed).toHaveBeenCalledTimes(1);expect(f.io.cleanup).not.toHaveBeenCalled();task.dispose();
 });
 it('discards rejected bytes only after an unchanged read and prepares a fresh audience',async()=>{
  const f=fixture();f.io.list.mockResolvedValue({items:[{id:'a'}]});f.io.save.mockRejectedValueOnce(new ApiError(409,{error:{code:'AUDIENCE_CHANGED'}}));
  const task=startAccessUpdates(f.io);await flush();expect(f.io.cleanup).toHaveBeenCalledTimes(1);
  f.advance(5001);await task.recheck();expect(f.io.prepare).toHaveBeenCalledTimes(2);task.dispose();
 });
 it('does not resend stale bytes after another device changes the object',async()=>{
  const f=fixture();f.io.list.mockResolvedValue({items:[{id:'a'}]});f.io.save.mockRejectedValueOnce(Error('lost'));
  f.io.reconcile.mockRejectedValueOnce(Error('lost read')).mockResolvedValue('changed');
  const task=startAccessUpdates(f.io);await flush();f.io.list.mockResolvedValue({items:[]});f.advance(5001);await task.recheck();
  expect(f.io.save).toHaveBeenCalledTimes(1);expect(f.io.cleanup).not.toHaveBeenCalled();expect(f.io.state).toHaveBeenLastCalledWith('idle');task.dispose();
 });
 it('never retries while offline; resumes automatically on foreground/online',async()=>{
  const f=fixture();f.online(false);const task=startAccessUpdates(f.io);await flush();expect(f.io.list).not.toHaveBeenCalled();
  f.online(true);await task.recheck();expect(f.completed.size).toBe(3);task.dispose();
 });
 it('does not let recovered own-device skips consume the write budget or starve later photos',async()=>{
  const f=fixture();f.io.prepare.mockImplementation(async id=>id==='d'?{id,bytes:'encrypted'}:null);
  const task=startAccessUpdates(f.io);await flush();expect([...f.completed]).toEqual(['d']);expect(f.io.changed).toHaveBeenCalledTimes(1);task.dispose();
 });
 it('caps backoff without giving up on an unavailable key',async()=>{
  const f=fixture();f.io.list.mockResolvedValue({items:[{id:'a'}]});f.io.prepare.mockRejectedValue(Error('key unavailable'));
  const task=startAccessUpdates(f.io);await flush();
  for(let i=0;i<12;i++){f.advance(300001);await task.recheck();}
  expect(f.io.prepare).toHaveBeenCalledTimes(13);
  f.io.prepare.mockResolvedValue({id:'a',bytes:'now available'});f.advance(300001);await task.recheck();expect(f.completed.has('a')).toBe(true);task.dispose();
 });
});
