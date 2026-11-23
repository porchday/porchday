import {afterEach,expect,it,vi} from 'vitest';
import {readStatus} from '../src/read-status';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(){
 vi.useFakeTimers();const log=vi.spyOn(console,'log').mockImplementation(()=>{});
 const calls:ReturnType<typeof vi.fn>[]=[];
 const get=vi.fn(()=>{const fetch=vi.fn();calls.push(fetch);return {fetch};});
 const namespace={idFromName:vi.fn(()=>({})),get} as unknown as DurableObjectNamespace;
 return {namespace,get,calls,log};
}
it('reacquires a stub once for an explicitly retryable read failure and retains only fixed diagnostics',async()=>{
 const f=fixture(),response=Response.json({status:'operational'});
 f.get.mockImplementationOnce(()=>({fetch:vi.fn().mockRejectedValue(Object.assign(Error('private-token'),{retryable:true}))}));
 const second=vi.fn().mockResolvedValue(response);f.get.mockImplementationOnce(()=>({fetch:second}));
 const result=readStatus(f.namespace);await vi.advanceTimersByTimeAsync(200);
 expect(await(await result).json()).toEqual({status:'operational'});expect(f.get).toHaveBeenCalledTimes(2);
 expect(second.mock.calls[0][0]).toBe('https://monitor.internal/status');
 expect(JSON.stringify(f.log.mock.calls)).not.toContain('private-token');
 expect(JSON.parse(f.log.mock.calls[0][0])).toEqual({event:'monitor',code:'status_read_failed',attempt:1,retryable:true,overloaded:false});
});
it.each([{retryable:true,overloaded:true},{retryable:false},{retryable:'true'},{}])('does not retry an overload or unclassified exception: %j',async flags=>{
 const f=fixture(),error=Object.assign(Error('private'),flags);f.get.mockImplementation(()=>({fetch:vi.fn().mockRejectedValue(error)}));
 await expect(readStatus(f.namespace)).rejects.toBe(error);expect(f.get).toHaveBeenCalledTimes(1);
});
it('never retries an HTTP failure response',async()=>{
 const f=fixture(),response=new Response('unknown',{status:503});f.get.mockImplementation(()=>({fetch:vi.fn().mockResolvedValue(response)}));
 const result=await readStatus(f.namespace);expect(result.status).toBe(503);expect(await result.text()).toBe('unknown');expect(f.get).toHaveBeenCalledTimes(1);
});
it('caps transient retries at two attempts',async()=>{
 const f=fixture(),error=Object.assign(Error('private'),{retryable:true});f.get.mockImplementation(()=>({fetch:vi.fn().mockRejectedValue(error)}));
 const result=expect(readStatus(f.namespace)).rejects.toBe(error);await vi.advanceTimersByTimeAsync(200);await result;expect(f.get).toHaveBeenCalledTimes(2);
});
it('returns by the total deadline even when the transport ignores abort, without starting another attempt',async()=>{
 const f=fixture();let signal:AbortSignal|undefined;
 f.get.mockImplementation(()=>({fetch:vi.fn((_url,init)=>{signal=init.signal;return new Promise<Response>(()=>{});})}));
 const result=expect(readStatus(f.namespace)).rejects.toThrow('MONITOR_STATUS_DEADLINE');await vi.advanceTimersByTimeAsync(3000);await result;
 expect(signal?.aborted).toBe(true);expect(f.get).toHaveBeenCalledTimes(1);
});
it('bounds response size without replaying a response-body failure',async()=>{
 const f=fixture();f.get.mockImplementation(()=>({fetch:vi.fn().mockResolvedValue(new Response('x'.repeat(16385)))}));
 await expect(readStatus(f.namespace)).rejects.toThrow('MONITOR_STATUS_RESPONSE_TOO_LARGE');expect(f.get).toHaveBeenCalledTimes(1);
});
it('includes a stalled response body in the total deadline',async()=>{
 const f=fixture();let signal:AbortSignal|undefined;const cancel=vi.fn();
 f.get.mockImplementation(()=>({fetch:vi.fn(async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel}));})}));
 const result=expect(readStatus(f.namespace)).rejects.toThrow('MONITOR_STATUS_DEADLINE');await vi.advanceTimersByTimeAsync(3000);await result;
 expect(signal?.aborted).toBe(true);expect(f.get).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledTimes(1);
});
