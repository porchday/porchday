import {afterEach,expect,it,vi} from 'vitest';
import {withOperatorAddress} from './operator-dns';
afterEach(()=>vi.useRealTimers());
it('retries transient DNS failures before dispatching exactly one request',async()=>{
 vi.useFakeTimers();const lookup=vi.fn().mockRejectedValueOnce(Error('negative DNS reply')).mockResolvedValueOnce([]).mockResolvedValue(['192.0.2.1']);
 const dispatch=vi.fn(async()=> 'confirmed'),pending=withOperatorAddress(lookup,dispatch,Date.now()+30000);
 await vi.advanceTimersByTimeAsync(299);expect(dispatch).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(await pending).toBe('confirmed');expect(lookup).toHaveBeenCalledTimes(3);expect(dispatch).toHaveBeenCalledExactlyOnceWith('192.0.2.1',29700);expect(vi.getTimerCount()).toBe(0);
});
it('never retries dispatch after an uncertain HTTP write',async()=>{
 const lookup=vi.fn(async()=>['192.0.2.1']),dispatch=vi.fn(async()=>{throw Error('write reply lost');});
 await expect(withOperatorAddress(lookup,dispatch,Date.now()+30000)).rejects.toThrow('write reply lost');
 expect(lookup).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);
});
it('bounds a stalled DNS lookup and ignores its late result',async()=>{
 vi.useFakeTimers();let resolve!:(value:string[])=>void;const lookup=vi.fn(()=>new Promise<string[]>(r=>{resolve=r;})),dispatch=vi.fn(async()=>true);
 const pending=withOperatorAddress(lookup,dispatch,Date.now()+30000),verdict=expect(pending).rejects.toThrow('OPERATOR_DNS_NOT_READY');
 await vi.advanceTimersByTimeAsync(5000);await verdict;resolve(['192.0.2.1']);await vi.advanceTimersByTimeAsync(1);
 expect(dispatch).not.toHaveBeenCalled();expect(lookup).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
it('honors a shorter overall deadline, including backoff, without dispatch',async()=>{
 vi.useFakeTimers();const lookup=vi.fn(async()=>{throw Error('not ready');}),dispatch=vi.fn(async()=>true);
 const pending=withOperatorAddress(lookup,dispatch,Date.now()+50),verdict=expect(pending).rejects.toThrow('OPERATOR_DNS_NOT_READY');
 await vi.advanceTimersByTimeAsync(50);await verdict;expect(lookup).toHaveBeenCalledTimes(1);expect(dispatch).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('rejects unusable answers after at most three lookups and hides resolver details',async()=>{
 vi.useFakeTimers();const lookup=vi.fn(async()=>['::1','invalid']),dispatch=vi.fn(async()=>true);
 const pending=withOperatorAddress(lookup,dispatch,Date.now()+30000),verdict=expect(pending).rejects.toThrow('OPERATOR_DNS_NOT_READY');
 await vi.advanceTimersByTimeAsync(300);await verdict;expect(lookup).toHaveBeenCalledTimes(3);expect(dispatch).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('subtracts DNS time from the request deadline instead of extending the HTTP budget',async()=>{
 vi.useFakeTimers();const lookup=vi.fn(()=>new Promise<string[]>(r=>setTimeout(()=>r(['192.0.2.1']),200))),dispatch=vi.fn(async()=>true);
 const pending=withOperatorAddress(lookup,dispatch,Date.now()+1000);await vi.advanceTimersByTimeAsync(200);expect(await pending).toBe(true);expect(dispatch).toHaveBeenCalledExactlyOnceWith('192.0.2.1',800);
});
