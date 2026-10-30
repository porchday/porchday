import {expect,test,vi} from 'vitest';
import {probeReleaseContinuity,watchReleaseContinuity} from './release-continuity';
const target={environment:'staging' as const,memberId:'00000000-0000-4000-8000-000000000001',cookie:'session=allowed-private',deniedCookie:'session=denied-private',healthToken:'private-health-token'};
function transport(){return vi.fn(async(input:any,init:any)=>{
 const path=new URL(String(input)).pathname;
 if(path.endsWith('/health'))return Response.json({status:'ok',issues:[]});
 if(path.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'private, no-store'}});
 return init.headers.Cookie===target.cookie?Response.json({id:target.memberId},{headers:{'cache-control':'private, no-store'}}):Response.json({error:'unauthorized'},{status:401});
});}
const run=(fetch:typeof globalThis.fetch,assertScope=()=>{})=>probeReleaseContinuity({target,fetch,assertScope},new AbortController().signal);

test('reads existing allowed/denied sessions without mutation or credential output',async()=>{
 const fetch=transport(),sample=await run(fetch as typeof globalThis.fetch);expect(sample.healthy).toBe(true);expect(sample.checks).toHaveLength(4);
 for(const [url,init] of fetch.mock.calls){expect(String(url)).toMatch(/^https:\/\/staging\.porchday\.com\//);expect(init.method).toBe('GET');expect(init.redirect).toBe('error');}
 for(const secret of [target.memberId,target.cookie,target.deniedCookie,target.healthToken])expect(JSON.stringify(sample)).not.toContain(secret);
});

test.each(['profile','feed','denial','readiness'])('does not let passing readiness hide a failed %s check',async which=>{
 const normal=transport();const fetch=vi.fn(async(input:any,init:any)=>{
  const path=new URL(String(input)).pathname;
  if(which==='profile'&&path.endsWith('/me')&&init.headers.Cookie===target.cookie)return Response.json({id:'wrong-owner'},{headers:{'cache-control':'no-store'}});
  if(which==='feed'&&path.endsWith('/feed'))return Response.json({items:[]});
  if(which==='denial'&&init.headers.Cookie===target.deniedCookie)return Response.json({id:target.memberId});
  if(which==='readiness'&&path.endsWith('/health'))return Response.json({status:'ok',issues:['unavailable']});
  return normal(input,init);
 });
 const sample=await run(fetch as typeof globalThis.fetch);expect(sample.healthy).toBe(false);expect(sample.checks.filter(c=>!c.ok)).toHaveLength(1);
});

test('redacts transport errors and oversized/private response bodies',async()=>{
 const fetch=vi.fn(async(input:any)=>String(input).includes('/feed')?new Response('x'.repeat(65537)):Promise.reject(Error('private token and connection string')));
 const sample=await run(fetch as typeof globalThis.fetch);expect(sample.healthy).toBe(false);expect(sample.checks.every(c=>c.failure==='transport_or_response')).toBe(true);
 expect(JSON.stringify(sample)).not.toMatch(/private|connection|xxxx/);
});

test('scope loss before dispatch and after response prevents a usable sample',async()=>{
 const fetch=transport();await expect(run(fetch as typeof globalThis.fetch,()=>{throw Error('SCOPE_LOST');})).rejects.toThrow('SCOPE_LOST');expect(fetch).not.toHaveBeenCalled();
 let lost=false;const wrapped=async(input:any,init:any)=>{const response=await fetch(input,init);lost=true;return response;};
 await expect(run(wrapped as typeof globalThis.fetch,()=>{if(lost)throw Error('SCOPE_LOST');})).rejects.toThrow('SCOPE_LOST');
});

test('invalid credentials and already-aborted callers cannot dispatch reads',async()=>{
 const fetch=transport();
 await expect(probeReleaseContinuity({target:{...target,cookie:'bad\r\nheader'},assertScope:()=>{},fetch:fetch as typeof globalThis.fetch},new AbortController().signal)).rejects.toThrow('CONTINUITY_CREDENTIAL_INVALID');
 await expect(probeReleaseContinuity({target:{...target,deniedCookie:target.cookie},assertScope:()=>{},fetch:fetch as typeof globalThis.fetch},new AbortController().signal)).rejects.toThrow('CONTINUITY_SESSIONS_NOT_DISTINCT');
 const abort=new AbortController();abort.abort();await expect(probeReleaseContinuity({target,assertScope:()=>{},fetch:fetch as typeof globalThis.fetch},abort.signal)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});

test('shared request deadline records failure without retrying or increasing the bound',async()=>{
 const signals:AbortSignal[]=[];const fetch=vi.fn(async(_input:any,init:any)=>{signals.push(init.signal);return await new Promise<Response>(()=>{});});
 const sample=await probeReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},timeoutMs:100},new AbortController().signal);
 expect(sample.healthy).toBe(false);expect(fetch).toHaveBeenCalledTimes(4);expect(new Set(signals).size).toBe(1);expect(signals.every(s=>s.aborted)).toBe(true);
});

test('stalled bodies are bounded and cancelled without waiting forever for cancellation',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const fetch=vi.fn(async()=>new Response(new ReadableStream({pull(){return new Promise<void>(()=>{});},cancel})));
 const sample=await probeReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},timeoutMs:100},new AbortController().signal);
 expect(sample.healthy).toBe(false);expect(cancel).toHaveBeenCalledTimes(4);
});

test('late responses cannot revive a failed sample and their bodies are discarded',async()=>{
 let resolve!:(value:Response)=>void;const held=new Promise<Response>(r=>{resolve=r;});
 const cancel=vi.fn();const fetch=vi.fn(async()=>held);
 const sample=await probeReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},timeoutMs:100},new AbortController().signal);
 resolve(new Response(new ReadableStream({cancel})));await new Promise(r=>setTimeout(r,0));
 expect(sample.healthy).toBe(false);expect(sample.checks.every(c=>!c.ok)).toBe(true);expect(fetch).toHaveBeenCalledTimes(4);expect(cancel).toHaveBeenCalled();
});

test('watch retains a failed sample before stopping and does not reinterpret it as healthy',async()=>{
 const fetch=transport();let stop=false;const retained:any[]=[];
 fetch.mockImplementation(async()=>Response.json({}, {status:503}));
 const result=await watchReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},stop:()=>stop,retain:async(index,sample)=>{retained.push({index,sample});stop=true;}},new AbortController().signal);
 expect(result).toMatchObject({reason:'stopped',samples:1,failedSamples:1});expect(retained[0].sample.healthy).toBe(false);expect(fetch).toHaveBeenCalledTimes(4);
});

test('retention failure stops the watch without another sample or a successful summary',async()=>{
 const fetch=transport();await expect(watchReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},stop:()=>false,retain:async()=>{throw Error('EVIDENCE_WRITE_FAILED');}},new AbortController().signal)).rejects.toThrow('EVIDENCE_WRITE_FAILED');
 expect(fetch).toHaveBeenCalledTimes(4);
});

test('watch reports empty coverage and sample exhaustion explicitly',async()=>{
 const fetch=transport();const base={target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},retain:()=>{}};
 expect(await watchReleaseContinuity({...base,stop:()=>true},new AbortController().signal)).toMatchObject({reason:'stopped',samples:0});expect(fetch).not.toHaveBeenCalled();
 expect(await watchReleaseContinuity({...base,stop:()=>false,maxSamples:1},new AbortController().signal)).toMatchObject({reason:'sample_limit',samples:1});
});

test.each([
 ['transport',undefined,()=>Promise.reject(Object.assign(Error('private token'),{message:'CONTINUITY_RESPONSE_TOO_LARGE',cause:{secret:'private'}}))],
 ['missing_body',401,()=>new Response(null,{status:401})],
 ['body_limit',503,()=>new Response('private'.repeat(10000),{status:503})],
 ['json_parse',401,()=>new Response('private non-json body',{status:401})],
 ['body_read',502,()=>new Response(new ReadableStream({start(controller){controller.error(Error('private body error'));}}),{status:502})],
] as const)('retains fixed %s diagnostics and observed status without private content',async(stage,status,response)=>{
 const normal=transport();const fetch=vi.fn(async(input:any,init:any)=>init.headers.Cookie===target.deniedCookie?await response():normal(input,init));
 const sample=await run(fetch as typeof globalThis.fetch),failed=sample.checks.find(c=>c.name==='denied_profile')!;
 expect(sample.healthy).toBe(false);expect(sample.checks.filter(c=>!c.ok)).toHaveLength(1);
 expect(failed).toMatchObject({ok:false,failure:'transport_or_response',failureStage:stage});expect(failed.status).toBe(status);
 expect(fetch).toHaveBeenCalledTimes(4);expect(JSON.stringify(sample)).not.toMatch(/private|CONTINUITY_RESPONSE|secret|cause/);
});

test('body deadline retains received status without accepting the response',async()=>{
 const normal=transport(),fetch=vi.fn(async(input:any,init:any)=>init.headers.Cookie===target.deniedCookie?new Response(new ReadableStream({pull(){return new Promise<void>(()=>{});}}),{status:401}):normal(input,init));
 const sample=await probeReleaseContinuity({target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},timeoutMs:100},new AbortController().signal);
 expect(sample.healthy).toBe(false);expect(sample.checks.find(c=>c.name==='denied_profile')).toMatchObject({ok:false,status:401,failureStage:'deadline'});expect(fetch).toHaveBeenCalledTimes(4);
});

test.each([
 ['UND_ERR_SOCKET','socket_closed'],['ECONNRESET','connection_reset'],
 ['ECONNREFUSED','connection_refused'],['ENOTFOUND','dns_lookup'],
 ['EAI_AGAIN','dns_lookup'],['ETIMEDOUT','connection_timeout'],
 ['UND_ERR_CONNECT_TIMEOUT','connection_timeout'],['CERT_HAS_EXPIRED','tls_certificate'],
 ['ERR_TLS_CERT_ALTNAME_INVALID','tls_certificate'],['private arbitrary code','unknown'],
])('retains only a fixed network category for %s without retries',async(code,category)=>{
 const normal=transport(),fetch=vi.fn(async(input:any,init:any)=>{
  if(String(input).endsWith('/health'))throw Object.assign(Error('private URL and token'),{cause:{code,socket:{remoteAddress:'private address'}}});
  return normal(input,init);
 });
 const sample=await run(fetch as typeof globalThis.fetch);
 expect(sample.healthy).toBe(false);expect(sample.checks.filter(c=>!c.ok)).toHaveLength(1);
 expect(sample.checks.find(c=>c.name==='protected_readiness')).toMatchObject({failureStage:'transport',networkFailure:category,ok:false});
 expect(fetch).toHaveBeenCalledTimes(4);expect(JSON.stringify(sample)).not.toMatch(/private|cause|remoteAddress|UND_ERR|ECONN|CERT_|TLS_/);
});

test('network classification does not invoke error getters or traverse arbitrary cause chains',async()=>{
 const getter=vi.fn(()=>{throw Error('private getter');});
 const errors=[Object.defineProperty({},'code',{get:getter}),Object.defineProperty({},'cause',{get:getter}),{cause:{cause:{code:'ECONNRESET'}}},null];
 const fetch=vi.fn(async()=>{throw errors.shift();});
 const sample=await run(fetch as typeof globalThis.fetch);
 expect(sample.checks.every(c=>!c.ok&&c.networkFailure==='unknown')).toBe(true);expect(getter).not.toHaveBeenCalled();
 expect(fetch).toHaveBeenCalledTimes(4);
});

test('body socket failure retains response status and deadline remains a separate classification',async()=>{
 const normal=transport(),fetch=vi.fn(async(input:any,init:any)=>String(input).endsWith('/health')?
  new Response(new ReadableStream({start(controller){controller.error({code:'ECONNRESET',message:'private'});}}),{status:200}):normal(input,init));
 const sample=await run(fetch as typeof globalThis.fetch);
 expect(sample.checks.find(c=>c.name==='protected_readiness')).toMatchObject({ok:false,status:200,failureStage:'body_read',networkFailure:'connection_reset'});
 const stalled=await probeReleaseContinuity({target,fetch:vi.fn(async()=>new Promise<Response>(()=>{})),assertScope:()=>{},timeoutMs:100},new AbortController().signal);
 expect(stalled.checks.every(c=>c.failureStage==='deadline'&&c.networkFailure===undefined)).toBe(true);
});
