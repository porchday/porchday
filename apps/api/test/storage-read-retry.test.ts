import {afterEach,describe,expect,it,vi} from 'vitest';
import {readStorageText} from '../src/storage-read-retry';
afterEach(()=>vi.useRealTimers());
describe('bounded read-only storage recovery',()=>{
 it('recovers rejected lookup and body reads with fresh lookups',async()=>{
  vi.useFakeTimers();const get=vi.fn().mockRejectedValueOnce(Error('private transport')).mockResolvedValueOnce({etag:'old',text:async()=>{throw Error('private body');}}).mockResolvedValue({etag:'current',text:async()=>'canonical'});
  const pending=readStorageText({get},'key');await vi.runAllTimersAsync();const result=await pending;
  expect(await result?.text()).toBe('canonical');expect(result?.etag).toBe('current');expect(get).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
 });
 it('keeps persistent failure closed and bounded without exposing error details',async()=>{
  vi.useFakeTimers();const get=vi.fn().mockRejectedValue(Error('credential'));
  const verdict=expect(readStorageText({get},'key')).rejects.toThrow(/^STORAGE_READ_UNAVAILABLE$/);
  await vi.runAllTimersAsync();await verdict;expect(get).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
 });
 it.each([null,{etag:'x',text:async()=>'malformed but successfully read'}])('does not retry missing or malformed content (%#)',async object=>{
  const get=vi.fn().mockResolvedValue(object);await readStorageText({get},'key');expect(get).toHaveBeenCalledTimes(1);
 });
 it('does not start a body read or retry after a timed-out lookup eventually resolves',async()=>{
  vi.useFakeTimers();let finish!:(value:unknown)=>void;const text=vi.fn(async()=>'late'),get=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
  const verdict=expect(readStorageText({get:get as never},'key')).rejects.toThrow('STORAGE_READ_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(2000);await verdict;finish({etag:'late',text});await vi.runAllTimersAsync();
  expect(text).not.toHaveBeenCalled();expect(get).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('reproduces a short storage outage exhausting attempts before the read deadline',async()=>{
  vi.useFakeTimers();const random=vi.spyOn(Math,'random').mockReturnValue(0),started=Date.now();
  // Production traces show short rejected reads, not a two-second hung lookup.
  // Keep this limitation explicit: a 400ms outage can exhaust the attempt cap.
  const get=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,70));if(Date.now()-started<400)throw Error('synthetic unavailable');return {etag:'fresh',text:async()=>'canonical'};});
  try{
   let outcome='pending';const pending=readStorageText({get},'key').then(()=>{outcome='read';},error=>{outcome=error.message;});
   await vi.advanceTimersByTimeAsync(360);await pending;
   expect(outcome).toBe('STORAGE_READ_UNAVAILABLE');expect(get).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
   await vi.advanceTimersByTimeAsync(40);const fresh=readStorageText({get},'key');await vi.advanceTimersByTimeAsync(70);
   expect(await (await fresh)?.text()).toBe('canonical');
  }finally{random.mockRestore();}
 });
 it('shares two seconds across retries instead of resetting the deadline',async()=>{
  vi.useFakeTimers();const get=vi.fn().mockRejectedValueOnce(Error('transient')).mockImplementation(()=>new Promise(()=>{}));
  const verdict=expect(readStorageText({get},'key')).rejects.toThrow('STORAGE_READ_UNAVAILABLE');await vi.advanceTimersByTimeAsync(2000);await verdict;
  expect(get).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
});
