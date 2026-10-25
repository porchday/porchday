import {describe,it,expect,vi,afterEach} from 'vitest';
import worker,{Monitor,type Env} from '../src/index';
import {initialState,observe,probe,publicStatus} from '../src/protocol';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const start=Date.UTC(2026,9,25,12);
class Storage {
  data=new Map<string,unknown>();fail=false;
  async get<T>(key:string):Promise<T|undefined>{if(this.fail)throw Error('private-database-password');return structuredClone(this.data.get(key)) as T|undefined;}
  async put(key:string,value:unknown){if(this.fail)throw Error('private-database-password');this.data.set(key,structuredClone(value));}
}
function fixture(){
  const storage=new Storage(),mail=vi.fn().mockResolvedValue({messageId:'synthetic'});
  let queue:Promise<unknown>=Promise.resolve();
  const ctx={storage,blockConcurrencyWhile<T>(work:()=>Promise<T>){const next=queue.then(work);queue=next.catch(()=>{});return next;}} as unknown as DurableObjectState;
  const env={ENVIRONMENT:'staging',OPERATIONS_HEALTH_TOKEN:'token-never-published-01234567890123456789',MONITOR_RECIPIENT:'operator@example.test',EMAIL_FROM:'Porchday <accounts@porchday.com>',EMAIL:{send:mail}} as unknown as Env;
  const monitor=new Monitor(ctx,env);
  env.STATE={idFromName:()=>({}),get:()=>({fetch:(url:string,init?:RequestInit)=>monitor.fetch(new Request(url,init))})} as unknown as DurableObjectNamespace;
  const tick=async(minute:number)=>{vi.setSystemTime(start+minute*60000);return monitor.fetch(new Request('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor((start+minute*60000)/60000))}}));};
  return{storage,mail,monitor,env,tick};
}
const healthy=()=>new Response(JSON.stringify({status:'ok',issues:[],snapshot:{cleanup_age_seconds:1}}));
describe('Independent operational monitor',()=>{
  it('uses a fixed target, bounded protected response, and refuses unsafe redirect semantics',async()=>{
    const fetcher=vi.fn().mockResolvedValue(healthy());
    expect(await probe('staging','x'.repeat(40),fetcher)).toEqual({healthy:true});
    expect(fetcher.mock.calls[0][0]).toBe('https://staging.porchday.com/api/operations/health');
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{Authorization:'Bearer '+'x'.repeat(40)}});
    fetcher.mockResolvedValue(new Response('private error text',{status:503}));expect(await probe('production','x'.repeat(40),fetcher)).toEqual({healthy:false});
    fetcher.mockResolvedValue(new Response('x'.repeat(16385)));expect(await probe('staging','x'.repeat(40),fetcher)).toEqual({healthy:false});
    fetcher.mockResolvedValue(new Response(JSON.stringify({status:'ok',issues:['private secret'],snapshot:{}})));expect(await probe('staging','x'.repeat(40),fetcher)).toEqual({healthy:false});
    expect(await probe('https://attacker.test' as any,'x'.repeat(40),fetcher)).toEqual({healthy:false});
  });
  it('times out even when a transport ignores AbortSignal and releases the cancellation signal',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn().mockImplementation(()=>new Promise(()=>{}));
    const result=probe('staging','x'.repeat(40),fetcher);await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toEqual({healthy:false});expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('requires three failures and two recoveries, deduplicates cron, and limits reminders to six hours',async()=>{
    vi.useFakeTimers();const f=fixture();const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('secret error',{status:503}));
    await f.tick(0);await f.tick(1);expect(f.mail).not.toHaveBeenCalled();
    await Promise.all([f.tick(2),f.tick(2)]);expect(f.mail).toHaveBeenCalledTimes(1);
    for(let i=3;i<=361;i++)await f.tick(i);expect(f.mail).toHaveBeenCalledTimes(1);
    await f.tick(362);expect(f.mail).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async()=>healthy());await f.tick(363);expect(f.mail).toHaveBeenCalledTimes(2);
    await f.tick(364);expect(f.mail).toHaveBeenCalledTimes(3);expect(f.mail.mock.calls[2][0].subject).toContain('recovered');
    const response=await worker.fetch(new Request('https://status.porchday.com/status'),f.env);
    expect(await response.json()).toEqual({status:'operational',last_checked_at:new Date(start+364*60000).toISOString()});
    const exposed=JSON.stringify(f.mail.mock.calls);expect(exposed).not.toContain('secret error');expect(exposed).not.toContain(f.env.OPERATIONS_HEALTH_TOKEN);expect(exposed).not.toContain('/api/operations/health');
  });
  it('persists bounded retries before email I/O and never turns storage errors into application requests',async()=>{
    vi.useFakeTimers();const f=fixture();vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('',{status:503}));
    const logs=vi.spyOn(console,'log').mockImplementation(()=>{});f.mail.mockRejectedValue(Error('operator@example.test private-provider-response'));
    await f.tick(0);await f.tick(1);await f.tick(2);for(let i=3;i<7;i++)await f.tick(i);expect(f.mail).toHaveBeenCalledTimes(1);
    await f.tick(7);expect(f.mail).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-provider-response');expect(JSON.stringify(logs.mock.calls)).not.toContain('operator@example.test');
    f.storage.fail=true;const before=f.mail.mock.calls.length;
    await expect(f.tick(8)).rejects.toThrow();expect(f.mail).toHaveBeenCalledTimes(before);
    const status=await worker.fetch(new Request('https://status.porchday.com/'),f.env);expect(status.status).toBe(503);expect(await status.json()).toEqual({status:'unknown',last_checked_at:null});
  });
  it('exposes no public probe or email trigger and reports stale monitoring as unknown',async()=>{
    vi.useFakeTimers();const f=fixture();vi.setSystemTime(start);
    const fetcher=vi.spyOn(globalThis,'fetch');
    for(const [method,path] of [['POST','/tick'],['GET','/tick'],['POST','/'],['GET','/api/operations/health']])expect((await worker.fetch(new Request('https://status.porchday.com'+path,{method}),f.env)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();expect(f.mail).not.toHaveBeenCalled();
    const state=observe(initialState(),true,start,1);expect(publicStatus(state,start+180001).status).toBe('unknown');
  });
  it('does not send a recovery message for an incident whose outage alert was never delivered',async()=>{
    vi.useFakeTimers();const f=fixture();const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('',{status:503}));vi.spyOn(console,'log').mockImplementation(()=>{});f.mail.mockRejectedValue(Error('unavailable'));
    await f.tick(0);await f.tick(1);await f.tick(2);fetcher.mockImplementation(async()=>healthy());await f.tick(3);await f.tick(4);await f.tick(10);
    expect(f.mail).toHaveBeenCalledTimes(1);expect((await f.storage.get<any>('state')).pending).toBeNull();
  });
});
