import {expect,test,vi} from 'vitest';
import {collect,timing,type Plan} from './staging-latency-collector';
const member='11111111-1111-4111-8111-111111111111',post='22222222-2222-4222-8222-222222222222',deployment='33333333-3333-4333-8333-333333333333';
const plan=():Plan=>({synthetic:true,origin:'https://staging.porchday.com',cookie:'private-session',memberId:member,postId:post,deployment,expiresAt:'2026-10-29T01:00:00Z',attempts:4,intervalMs:1000,timeoutMs:1000});
function fixture(){let now=Date.parse('2026-10-29T00:00:00Z');const calls:{url:string;init:any}[]=[];let fail=false;
 const io={now:()=>now,monotonic:()=>now,sleep:vi.fn(async(ms:number)=>{now+=ms;}),record:vi.fn(async()=>{}),fetch:vi.fn(async(url:any,init:any)=>{calls.push({url,init});now+=100;
 return Response.json(url.endsWith('/health')?{release:deployment}:url.includes('/me')?{id:member,handle:'qa_latency'}:{items:[{id:post}]},{status:fail?503:200,headers:{'cache-control':'private, no-store','server-timing':'worker;dur=75, journal_check;dur=40'}});
 }) as any};return {io,calls,fail:()=>{fail=true;}};
}
test('bounds sequential staging reads, validates fixture, and never emits bodies/cookies',async()=>{
 const f=fixture(),r=await collect(plan(),f.io);expect(r.reason).toBe('complete');expect(r.samples).toHaveLength(4);
 expect(f.calls).toHaveLength(6);expect(f.calls[0].init.headers.Cookie).toBeUndefined();
 expect(f.calls.every(c=>c.url.startsWith('https://staging.porchday.com/'))).toBe(true);
 expect(f.calls.every(c=>c.init.redirect==='error')).toBe(true);expect(f.io.sleep).toHaveBeenCalledTimes(3);
 expect(r.samples[0]).toMatchObject({elapsedMs:100,serverMs:75,outcome:'success'});
 expect(JSON.stringify(r)).not.toMatch(/private-session|11111111|22222222/);
});
test('rejects production and unbounded plans before traffic',async()=>{
 for(const changes of [{origin:'https://porchday.org'},{attempts:101},{intervalMs:0},{synthetic:false},{expiresAt:'2020-01-01'}]){
 const f=fixture();await expect(collect({...plan(),...changes} as Plan,f.io)).rejects.toThrow('INVALID_STAGING_LATENCY_PLAN');expect(f.calls).toHaveLength(0);
 }
});
test('retains timeout then stops instead of retrying or dropping the attempt',async()=>{
 const f=fixture();f.io.fetch.mockImplementationOnce(async()=>Response.json({release:deployment})).mockImplementationOnce(async()=>{throw Object.assign(Error('secret'),{name:'TimeoutError'});});
 const r=await collect(plan(),f.io);expect(r.reason).toBe('failed-attempt');expect(r.samples).toHaveLength(1);expect(r.samples[0].outcome).toBe('timeout');expect(f.io.record).toHaveBeenCalledOnce();
});
test('wrong account cannot count as successful evidence',async()=>{
 const f=fixture();f.io.fetch.mockImplementationOnce(async()=>Response.json({release:deployment})).mockImplementationOnce(async()=>Response.json({id:post},{headers:{'cache-control':'no-store'}}));
 const r=await collect(plan(),f.io);expect(r.samples[0].outcome).toBe('error');expect(r.reason).toBe('failed-attempt');
});
test('never includes arbitrary trace header values',()=>{
 expect(timing('worker;dur=2, password;dur=3, pd-trace;desc="secret", auth_session;dur=1')).toEqual({serverMs:2,phases:{worker:2,auth_session:1}});
});

test('empty feed stops with retained successful and failed attempts',async()=>{
 const f=fixture(),original=f.io.fetch.getMockImplementation()!;
 f.io.fetch.mockImplementation(async(url:any,init:any)=>url.endsWith('/feed')?Response.json({items:[]},{headers:{'cache-control':'no-store'}}):original(url,init));
 const r=await collect(plan(),f.io);
 expect(r.reason).toBe('failed-attempt');expect(r.samples.map(s=>s.outcome)).toEqual(['success','error']);expect(f.io.record).toHaveBeenCalledTimes(2);
});
test('deployment mismatch prevents traffic and change invalidates the run',async()=>{
 const f=fixture();f.io.fetch.mockImplementationOnce(async()=>Response.json({release:'other'}));
 expect((await collect(plan(),f.io)).reason).toBe('deployment-unverified');expect(f.io.fetch).toHaveBeenCalledOnce();
 const g=fixture(),original=g.io.fetch.getMockImplementation()!;let health=0;
 g.io.fetch.mockImplementation(async(url:any,init:any)=>url.endsWith('/health')&&++health===2?Response.json({release:'other'}):original(url,init));
 const r=await collect(plan(),g.io);expect(r.reason).toBe('deployment-changed');expect(r.samples).toHaveLength(4);
});
test('malformed error bodies retain HTTP status without exposing body text',async()=>{
 const f=fixture();f.io.fetch.mockImplementationOnce(async()=>Response.json({release:deployment})).mockImplementationOnce(async()=>new Response('private provider diagnostic',{status:503}));
 const r=await collect(plan(),f.io);expect(r.samples[0]).toMatchObject({outcome:'error',httpStatus:503});expect(JSON.stringify(r)).not.toContain('private provider');
});
test('journal failure stops further measurement and cannot report completion',async()=>{
 const f=fixture();f.io.record.mockRejectedValueOnce(Error('disk full'));
 const r=await collect(plan(),f.io);expect(r.reason).toBe('probe-interrupted');expect(r.samples).toHaveLength(1);expect(f.io.fetch).toHaveBeenCalledTimes(2);
});

test('reads current server span format without duplicate counting or trace metadata',()=>{
 const r=timing('worker;dur=80, auth_session;dur=20, pd-total;dur=85, pd-span;dur=20;desc="auth_session@2", pd-span;dur=5;desc="social_query@30", pd-span;dur=7;desc="social_query@40", pd-trace;desc="secret", pd-span;dur=4;desc="private_name@0"');
 expect(r).toEqual({serverMs:85,phases:{worker:80,auth_session:20,social_query:12}});
});
test('opts authenticated reads into tracing with fresh IDs but never uploads traces',async()=>{
 const f=fixture(),r=await collect(plan(),f.io);
 const headers=f.calls.filter(c=>c.init.headers.Cookie).map(c=>c.init.headers.traceparent);
 expect(headers).toHaveLength(4);expect(new Set(headers).size).toBe(4);
 for(const h of headers)expect(h).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
 expect(f.calls.filter(c=>!c.init.headers.Cookie).every(c=>!c.init.headers.traceparent)).toBe(true);
 for(const h of headers)expect(JSON.stringify(r)).not.toContain(h);
 expect(f.calls.some(c=>c.url.includes('/traces'))).toBe(false);
});
