import {describe,it,expect,vi,afterEach} from 'vitest';
import worker,{Monitor,type Env} from '../src/index';
import {initialState,observe,probe,publicStatus} from '../src/protocol';
import {renderStatusPage} from '../src/status-page';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const start=Date.UTC(2026,9,25,12);
class Storage {
  data=new Map<string,unknown>();fail=false;
  async get<T>(key:string):Promise<T|undefined>{if(this.fail)throw Error('private-database-password');return structuredClone(this.data.get(key)) as T|undefined;}
  async put(key:string|Record<string,unknown>,value?:unknown){if(this.fail)throw Error('private-database-password');for(const [name,item] of typeof key==='string'?[[key,value]]:Object.entries(key))this.data.set(name,structuredClone(item));}
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
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'manual',headers:{Authorization:'Bearer '+'x'.repeat(40)}});
    fetcher.mockResolvedValue(new Response(null,{status:302,headers:{Location:'https://attacker.test'}}));expect(await probe('staging','x'.repeat(40),fetcher)).toEqual({healthy:false});expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(await response.json()).toEqual({status:'operational',last_checked_at:new Date(start+364*60000).toISOString(),metrics_monitoring:'not_configured'});
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
    const status=await worker.fetch(new Request('https://status.porchday.com/status'),f.env);expect(status.status).toBe(503);expect(await status.json()).toEqual({status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'});
    const page=await worker.fetch(new Request('https://status.porchday.com/'),f.env);expect(page.status).toBe(503);expect(await page.text()).toContain('Status unavailable');
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
  it('serves accessible HTML with a checked time and reports stale state without exposing diagnostics',async()=>{
    vi.useFakeTimers();vi.setSystemTime(start);const f=fixture();
    await f.storage.put('state',{...observe(initialState(),true,start,1),private_details:'private-member-email'});
    const response=await worker.fetch(new Request('https://status.porchday.com/'),f.env),html=await response.text();
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('Service checks are passing');expect(html).toContain('<html lang="en">');expect(html).toContain('aria-labelledby="status-heading"');expect(html).toContain('datetime="'+new Date(start).toISOString()+'"');expect(html).not.toContain('private-member-email');
    const nonce=html.match(/<style nonce="([a-f0-9-]+)">/)?.[1];expect(nonce).toBeTruthy();expect(response.headers.get('content-security-policy')).toContain("style-src 'nonce-"+nonce+"'");expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(html).not.toMatch(/<script|<img|<iframe|https?:\/\//);
    vi.setSystemTime(start+180001);const stale=await worker.fetch(new Request('https://status.porchday.com/'),f.env);expect(await stale.text()).toContain('Status unavailable');
    expect(await(await worker.fetch(new Request('https://status.porchday.com/status'),f.env)).json()).toEqual({status:'unknown',last_checked_at:new Date(start).toISOString(),metrics_monitoring:'not_configured'});
  });
  it('rejects HTML injection and private response fields before rendering, including malformed timestamps',async()=>{
    const response=renderStatusPage({status:'operational"><script>alert(1)</script>',last_checked_at:'"><img src=x onerror=alert(1)>',issues:['private-database-error'],snapshot:{member:'private-member'}});
    const html=await response.text();expect(html).toContain('Status unavailable');expect(html).toContain('No completed check yet');expect(html).not.toMatch(/<script|<img|alert\(1\)|private-/);
    expect(await renderStatusPage({status:'degraded',last_checked_at:new Date(start).toISOString()}).text()).toContain('Service needs attention');
    expect(await renderStatusPage({status:'checking',last_checked_at:null}).text()).toContain('Checking service status');
  });
  it('continues minute health checks when metrics queries fail and alerts monitoring failure without claiming an app outage',async()=>{
    vi.useFakeTimers();const f=fixture();Object.assign(f.env,{METRICS_ENABLED:'true',ANALYTICS_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_ANALYTICS_READ_TOKEN:'private-read-only-capability-123456789'});
    let queryFails=true;
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>{
      if(String(url).endsWith('/api/operations/health'))return healthy();
      if(String(url).endsWith('/health'))return Response.json({status:'ok',service:'porchday',environment:'staging'});
      return queryFails?new Response('private-provider-diagnostic',{status:403}):Response.json({data:[{route:'/health',requests:10,observations:10,server_errors:0,p95_ms:3,latest_timestamp:new Date().toISOString()}]});
    });
    for(let i=0;i<=10;i++)await f.tick(i);
    expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/api/operations/health'))).toHaveLength(11);
    expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/sql'))).toHaveLength(3);
    expect(f.mail).toHaveBeenCalledTimes(1);expect(f.mail.mock.calls[0][0].subject).toContain('metrics monitoring need attention');
    expect(await(await worker.fetch(new Request('https://status.porchday.com/status'),f.env)).json()).toEqual({status:'operational',last_checked_at:new Date(start+10*60000).toISOString(),metrics_monitoring:'unavailable'});
    queryFails=false;for(let i=11;i<=20;i++)await f.tick(i);
    expect(f.mail).toHaveBeenCalledTimes(2);expect(f.mail.mock.calls[1][0].subject).toContain('metrics monitoring recovered');
    expect(JSON.stringify([...f.storage.data])).not.toMatch(/private-|operator@example/);expect(JSON.stringify(f.mail.mock.calls)).not.toMatch(/private-|analytics_engine\/sql/);
  });
  it('sends at most one tracked alert per tick across channels and preserves retry isolation and duplicate-cron suppression',async()=>{
    vi.useFakeTimers();const f=fixture();Object.assign(f.env,{METRICS_ENABLED:'true',ANALYTICS_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_ANALYTICS_READ_TOKEN:'private-read-only-capability-123456789'});
    vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>{
      if(String(url).endsWith('/api/operations/health'))return healthy();
      if(String(url).endsWith('/health'))return Response.json({status:'ok',service:'porchday',environment:'staging'});
      return Response.json({data:[{route:'/health',requests:10,observations:10,server_errors:0,p95_ms:3,latest_timestamp:new Date().toISOString()},{route:'/api/v1/feed',requests:200,observations:100,server_errors:10,p95_ms:800,latest_timestamp:new Date().toISOString()}]});
    });
    for(let i=0;i<10;i++)await f.tick(i);
    f.mail.mockRejectedValueOnce(Error('private-provider-diagnostic'));vi.spyOn(console,'log').mockImplementation(()=>{});
    await Promise.all([f.tick(10),f.tick(10)]);expect(f.mail).toHaveBeenCalledTimes(1);expect(f.mail.mock.calls[0][0].subject).toContain('feed latency');
    await f.tick(11);expect(f.mail).toHaveBeenCalledTimes(2);expect(f.mail.mock.calls[1][0].subject).toContain('API error');
    for(let i=12;i<15;i++)await f.tick(i);expect(f.mail).toHaveBeenCalledTimes(2);
    await f.tick(15);expect(f.mail).toHaveBeenCalledTimes(3);expect(f.mail.mock.calls[2][0].subject).toContain('feed latency');
    const snapshot=await(await worker.fetch(new Request('https://status.porchday.com/status'),f.env)).json();expect(snapshot).toMatchObject({status:'degraded',metrics_monitoring:'ready'});
    expect(await(await worker.fetch(new Request('https://status.porchday.com/'),f.env)).text()).toContain('Performance and telemetry monitoring is receiving data.');
  });
  it('bounds parallel check and one email stall below the Durable Object concurrency-gate deadline',async()=>{
    vi.useFakeTimers();vi.setSystemTime(start);const f=fixture();Object.assign(f.env,{METRICS_ENABLED:'true',ANALYTICS_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_ANALYTICS_READ_TOKEN:'private-read-only-capability-123456789'});
    await f.storage.put('state',{...initialState(),failures:2});
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(()=>{}));f.mail.mockImplementation(()=>new Promise(()=>{}));vi.spyOn(console,'log').mockImplementation(()=>{});
    let completed=false;const pending=f.tick(0).then(response=>{completed=true;return response;});
    await vi.advanceTimersByTimeAsync(10001);expect(f.mail).toHaveBeenCalledTimes(1);expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(10001);expect((await pending).status).toBe(200);expect(completed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);for(const [,options] of fetcher.mock.calls)expect(options?.signal?.aborted).toBe(true);
    expect((await f.storage.get<any>('state')).pending.nextAttemptAt).toBeGreaterThan(Date.now());
  });
});
