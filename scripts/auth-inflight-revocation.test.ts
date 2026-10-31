import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createStagingInflightRevocation,inflightWaiterQuery} from './auth-inflight-revocation';
const directories:string[]=[];afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(postStatus=200){
 const directory=mkdtempSync(join(tmpdir(),'request-inflight-'));directories.push(directory);const controller=new AbortController();let release:()=>void=()=>{},pending=false;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 const session={memberId:crypto.randomUUID(),sessionId:crypto.randomUUID(),cookie:'owned-private-cookie'};
 const db={query:vi.fn(async(text:string,values?:unknown[])=>{
  if(text===inflightWaiterQuery){expect(values).toEqual([session.memberId,123]);return{rows:[{waiting:pending?1:0}]};}
  if(text.startsWith('SELECT EXISTS'))return{rows:[{owned:true}]};
  return{rows:[{n:'42',generation:crypto.randomUUID()}]};
 })};
 const lock={query:vi.fn(async(text:string,values?:unknown[])=>{if(text==='ROLLBACK')release();if(text.includes('pg_try_advisory')){expect(values).toEqual([session.memberId]);return{rows:[{pid:123,acquired:true}]};}return{rows:[]};}),release:vi.fn(),on:vi.fn()};
 const transport=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{expect(String(url).startsWith('https://staging.porchday.com/')).toBe(true);expect(init?.redirect).toBe('error');if(init?.method==='POST'){pending=true;await barrier;pending=false;return new Response(null,{status:postStatus});}return new Response(null,{status:401});});
 const options={directory,db,lock,session,assertScope:vi.fn(),transport:transport as typeof fetch};
 const probe=createStagingInflightRevocation(options,controller.signal);
 return{options,probe,controller,db,lock,transport,directory,release};
}
it('proves the owned SQL waiter on both sides and completes the original request once',async()=>{
 const f=fixture();expect(await f.probe.start(f.controller.signal)).toBe('in-flight');expect(f.transport).toHaveBeenCalledTimes(1);expect(()=>f.probe.result()).toThrow();
 expect(await f.probe.finish(f.controller.signal)).toBe('verified');expect(f.probe.result()).toMatchObject({markerBefore:'42',waitingBeforeDispatch:true,waitingAfterRestore:true});
 expect(f.lock.release).toHaveBeenCalledWith();expect(f.transport).toHaveBeenCalledTimes(2);expect(f.db.query.mock.calls.filter(([text])=>text===inflightWaiterQuery)).toHaveLength(2);
 expect(f.lock.query.mock.calls.map(([text])=>text)).toContain("SET LOCAL transaction_timeout='12s'");
 for(const n of readdirSync(f.directory))expect(readFileSync(join(f.directory,n),'utf8')).not.toContain('owned-private-cookie');
 await expect(f.probe.start(f.controller.signal)).rejects.toThrow();await expect(f.probe.finish(f.controller.signal)).rejects.toThrow();await f.probe.close();expect(f.lock.release).toHaveBeenCalledTimes(1);
});
it.each(['ownership','baseline','lock','cancel','scope','intent'])('refuses %s before HTTP mutation and destroys its client',async kind=>{
 const f=fixture(),query=f.db.query.getMockImplementation()!;
 if(kind==='ownership')f.db.query.mockImplementation(async(text,values)=>text.startsWith('SELECT EXISTS')?{rows:[{owned:false}]}:query(text,values));
 if(kind==='baseline')f.db.query.mockImplementation(async(text,values)=>text.includes('max(sequence)')?{rows:[{n:'bad',generation:'bad'}]}:query(text,values));
 if(kind==='lock')f.lock.query.mockResolvedValue({rows:[{pid:123,acquired:false}]});
 if(kind==='cancel')f.controller.abort();
 if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private scope');});
 if(kind==='intent')writeFileSync(join(f.directory,'inflight-request-intent.json'),'existing');
 await expect(f.probe.start(f.controller.signal)).rejects.toThrow('STAGING_INFLIGHT_REQUEST_UNVERIFIED');expect(f.transport).not.toHaveBeenCalled();expect(f.lock.release).toHaveBeenCalledWith(true);await f.probe.close();
});
it('never treats an early completed request as in flight',async()=>{
 const f=fixture();f.transport.mockResolvedValue(new Response(null,{status:200}));
 await expect(f.probe.start(f.controller.signal)).rejects.toThrow();expect(f.lock.release).toHaveBeenCalledWith(true);await f.probe.close();expect(f.transport).toHaveBeenCalledTimes(1);
});
it('retains an unknown POST without retry',async()=>{
 const f=fixture();f.transport.mockRejectedValue(Error('private transport payload'));
 await expect(f.probe.start(f.controller.signal)).rejects.toThrow();await f.probe.close();expect(f.transport).toHaveBeenCalledTimes(1);
 expect(JSON.parse(readFileSync(join(f.directory,'inflight-request-outcome.json'),'utf8')).known).toBe(false);
});
it.each(['missing-waiter','two-waiters','scope','abort','lock-release','denial-503','accepted-cookie','evidence'])('refuses %s after rollback observation',async kind=>{
 const f=fixture();await f.probe.start(f.controller.signal);
 if(kind==='missing-waiter'||kind==='two-waiters')f.db.query.mockResolvedValue({rows:[{waiting:kind==='missing-waiter'?0:2}]});
 if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private');});
 if(kind==='abort')f.controller.abort();
 if(kind==='lock-release')f.lock.query.mockRejectedValue(Error('private database error'));
 if(kind==='denial-503'){
  f.transport.mockResolvedValue(new Response(null,{status:503}));
 }
 if(kind==='accepted-cookie')f.transport.mockResolvedValue(new Response(null,{status:200}));
 if(kind==='evidence')writeFileSync(join(f.directory,'inflight-request-verified.json'),'existing');
 await expect(f.probe.finish(f.controller.signal)).rejects.toThrow();expect(()=>f.probe.result()).toThrow();f.release();await f.probe.close();expect(f.lock.release).toHaveBeenCalledTimes(1);
});
it('destroys the owned lock at the nine-second local deadline',async()=>{
 vi.useFakeTimers();const f=fixture();await f.probe.start(f.controller.signal);await vi.advanceTimersByTimeAsync(9000);expect(f.lock.release).toHaveBeenCalledWith(true);
 await expect(f.probe.finish(f.controller.signal)).rejects.toThrow();f.release();await f.probe.close();
});
it('closes an unknown request even when transport ignores cancellation',async()=>{
 const f=fixture();f.transport.mockImplementation(()=>new Promise(()=>{}));f.db.query.mockImplementation(async text=>text===inflightWaiterQuery?{rows:[{waiting:1}]}:text.startsWith('SELECT EXISTS')?{rows:[{owned:true}]}:{rows:[{n:'42',generation:crypto.randomUUID()}]});
 await f.probe.start(f.controller.signal);await f.probe.close();expect(f.lock.release).toHaveBeenCalledWith(true);expect(JSON.parse(readFileSync(join(f.directory,'inflight-request-outcome.json'),'utf8')).known).toBe(false);
});
it('destroys the connection on asynchronous database failure',async()=>{
 const f=fixture();await f.probe.start(f.controller.signal);f.lock.on.mock.calls[0][1]();await expect(f.probe.finish(f.controller.signal)).rejects.toThrow();f.release();await f.probe.close();expect(f.lock.release).toHaveBeenCalledWith(true);
});

it('retains a failed original POST without a denial request or retry',async()=>{
 const f=fixture(503);await f.probe.start(f.controller.signal);await expect(f.probe.finish(f.controller.signal)).rejects.toThrow();await f.probe.close();expect(f.transport).toHaveBeenCalledTimes(1);
 expect(JSON.parse(readFileSync(join(f.directory,'inflight-request-outcome.json'),'utf8'))).toMatchObject({known:true,status:503});
});
