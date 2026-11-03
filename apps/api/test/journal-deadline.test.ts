import {afterEach,describe,expect,it,vi} from 'vitest';
import {journalDeadline} from '../src/journal-deadline';
const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
afterEach(()=>vi.useRealTimers());
describe('journal caller deadlines',()=>{
 it('bounds a never-resolving initial call and refuses all subsequent dispatch',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:30000}),work=vi.fn(()=>new Promise<never>(()=>{}));
  const result=expect(io.run(work)).rejects.toThrow('JOURNAL_IO_DEADLINE');
  await vi.advanceTimersByTimeAsync(5000);await result;
  await expect(io.run(work)).rejects.toThrow('JOURNAL_IO_DEADLINE');expect(work).toHaveBeenCalledTimes(1);
 });
 it('does not consume a late GET body or continue into a write',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:30000}),get=deferred<{text:()=>Promise<string>}>(),text=vi.fn(async()=> 'late'),put=vi.fn(async()=>{});
  const result=expect(io.run(async scope=>{const object=await get.promise;scope.assertOpen();return object.text();}).then(()=>io.run(put))).rejects.toThrow('JOURNAL_IO_DEADLINE');
  await vi.advanceTimersByTimeAsync(5000);await result;get.resolve({text});await vi.advanceTimersByTimeAsync(1);
  expect(text).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
 });
 it('bounds body consumption and observes a late rejection',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:30000}),body=deferred<string>();
  const result=expect(io.run(async scope=>{scope.assertOpen();return body.promise;})).rejects.toThrow('JOURNAL_IO_DEADLINE');
  await vi.advanceTimersByTimeAsync(5000);await result;body.reject(Error('late private provider error'));await vi.advanceTimersByTimeAsync(1);
 });
 it('retains uncertainty when a timed-out write commits later; never resends it',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:30000}),reply=deferred<string>();let stored=false;
  const put=vi.fn(async()=>{await reply.promise;stored=true;return 'etag';});
  const result=expect(io.run(put)).rejects.toThrow('JOURNAL_IO_DEADLINE');await vi.advanceTimersByTimeAsync(5000);await result;
  reply.resolve('ok');await vi.advanceTimersByTimeAsync(1);expect(stored).toBe(true);
  await expect(io.run(put)).rejects.toThrow('JOURNAL_IO_DEADLINE');expect(put).toHaveBeenCalledTimes(1);
 });
 it('caps the total scope even when every individual call is below its deadline',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:12000});
  for(let i=0;i<2;i++){const result=io.run(()=>new Promise(resolve=>setTimeout(()=>resolve('ok'),4000)));await vi.advanceTimersByTimeAsync(4000);expect(await result).toBe('ok');}
  const result=expect(io.run(()=>new Promise(resolve=>setTimeout(resolve,4500)))).rejects.toThrow('JOURNAL_IO_DEADLINE');await vi.advanceTimersByTimeAsync(4000);await result;
 });
 it('does not equate a known transport rejection with a timeout',async()=>{
  const io=journalDeadline({attemptMs:5000,totalMs:30000});await expect(io.run(async()=>{throw Error('known rejection');})).rejects.toThrow('known rejection');await expect(io.run(async()=>42)).resolves.toBe(42);
 });
 it('uses one total deadline across concurrent calls',async()=>{
  vi.useFakeTimers();const io=journalDeadline({attemptMs:5000,totalMs:5000});
  const first=expect(io.run(()=>new Promise(()=>{}))).rejects.toThrow('JOURNAL_IO_DEADLINE');await vi.advanceTimersByTimeAsync(4000);
  const second=expect(io.run(()=>new Promise(()=>{}))).rejects.toThrow('JOURNAL_IO_DEADLINE');await vi.advanceTimersByTimeAsync(1000);await Promise.all([first,second]);
 });
});

it('rejects a late result even when the event loop has not delivered the timer yet',async()=>{
 let clock=0;const io=journalDeadline({attemptMs:5000,totalMs:30000,now:()=>clock});
 await expect(io.run(async()=>{clock=5001;return 'too late';})).rejects.toThrow('JOURNAL_IO_DEADLINE');
});
