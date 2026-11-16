import {it,expect,vi,afterEach} from 'vitest';
import {Hono} from 'hono';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';
import {createHealthDashboard,dashboardJson} from '../src/health-dashboard';
import {requireStaff} from '../src/staff';
import {readOperationalHealth} from '../src/operations-health';
import type {Env,Variables} from '../src/types';
const auth=vi.hoisted(()=>({query:vi.fn(),end:vi.fn(async()=>{})}));
vi.mock('../src/auth',()=>({authPool:()=>auth}));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
function fixture(){
 const audit=vi.fn(async()=>({success:true})),all=vi.fn(async()=>({results:[{trace_id:'a'.repeat(32),root_id:'b'.repeat(16),started_at:Date.now()-1000,route:'/api/v1/feed',status:503,reason:'error',duration:420,service:'api'}]}));
 const env={ENVIRONMENT:'production',OPERATIONS_HEALTH_TOKEN:'secret-not-for-browser',TRACES:{prepare:(sql:string)=>({bind:()=>({run:audit,all})})}} as unknown as Env;
 const request=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/status')?{status:'operational',last_checked_at:new Date(Date.now()-180000).toISOString(),metrics_monitoring:'ready',secret:'never-return'}:{error:{code:'PRIVACY_CHECKPOINT_REQUIRED'},secret:'never-return'}),{status:url.endsWith('/status')?200:503}));
 const health=vi.fn(async()=>({status:'degraded',issues:['cleanup_stale'],snapshot:{},backup:{}}));
 const app=new Hono<{Bindings:Env;Variables:Variables}>();app.onError(()=>new Response('unavailable',{status:503}));app.use('*',async(c,next)=>{c.set('staffSubject','operator');await next();});app.route('/',createHealthDashboard(request as typeof fetch,health as unknown as typeof readOperationalHealth));return{app,env,audit,all,request,health};
}
it('reports stale and degraded signals separately, strips payloads and audits reads',async()=>{
 const f=fixture(),r=await f.app.request('/',{},f.env),v=await r.json();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(v.readiness.state).toBe('degraded');expect(v.monitoring.fresh).toBe(false);expect(v.traces.errors).toBe(1);expect(v.traces.p95Ms).toBe(420);expect(v.externalMonitor.state).toBe('not_connected');expect(JSON.stringify(v)).not.toContain('never-return');expect(JSON.stringify(v)).not.toContain('secret-not-for-browser');expect(f.audit).toHaveBeenCalledOnce();expect(f.request.mock.calls.every(([u])=>['https://monitor.internal/status'].includes(u))).toBe(true);
});
it('does not fetch or query evidence if audit persistence fails',async()=>{const f=fixture();f.audit.mockRejectedValueOnce(Error('down'));expect((await f.app.request('/',{},f.env)).status).toBe(503);expect(f.request).not.toHaveBeenCalled();expect(f.all).not.toHaveBeenCalled();});
it('partial provider and trace failures are unknown rather than successful',async()=>{const f=fixture();f.request.mockRejectedValue(Error('network'));f.health.mockRejectedValue(Error('database'));f.all.mockRejectedValue(Error('D1'));const v=await (await f.app.request('/',{},f.env)).json();expect(v.readiness.state).toBe('unknown');expect(v.monitoring.status).toBe('unknown');expect(v.traces.state).toBe('unknown');});
it('rejects oversized provider bodies without exposing them',async()=>{await expect(dashboardJson('https://example.test',{},vi.fn(async()=>new Response('x'.repeat(65537))) as typeof fetch)).rejects.toThrow('TOO_LARGE');});
it('requires a verified Access assertion and current builder role, including revocation',async()=>{
 const f=fixture(),app=new Hono<{Bindings:Env;Variables:Variables}>();app.use('*',requireStaff('builder_chat'));app.route('/',createHealthDashboard(f.request as typeof fetch,f.health as unknown as typeof readOperationalHealth));
 const issuer='https://health-dashboard-test.cloudflareaccess.com',audience='health-test',env={...f.env,STAFF_ACCESS_ISSUER:issuer,STAFF_ACCESS_AUDIENCE:audience};
 const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'health'};vi.stubGlobal('fetch',vi.fn(async()=>Response.json({keys:[jwk]})));
 const token=await new SignJWT({email:'operator@example.test',type:'app'}).setProtectedHeader({alg:'RS256',kid:'health'}).setSubject('operator').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 const context={waitUntil:vi.fn(),passThroughOnException:vi.fn(),props:{}} as unknown as ExecutionContext;
 const call=(assertion?:string)=>app.fetch(new Request('https://porchday.org/',{headers:assertion?{'Cf-Access-Jwt-Assertion':assertion}:{}}),env,context);
 expect((await call()).status).toBe(401);expect((await call('forged')).status).toBe(401);auth.query.mockResolvedValue({rows:[{roles:['moderation']}]});expect((await call(token)).status).toBe(403);expect(f.audit).not.toHaveBeenCalled();auth.query.mockResolvedValue({rows:[{roles:['builder_chat']}]});expect((await call(token)).status).toBe(200);auth.query.mockResolvedValue({rows:[]});expect((await call(token)).status).toBe(403);expect(f.audit).toHaveBeenCalledOnce();
});

it('uses the bound monitor service and never fetches readiness over public HTTP',async()=>{const f=fixture();const service=vi.fn(async()=>Response.json({status:'operational',last_checked_at:new Date().toISOString()}));const app=new Hono<{Bindings:Env;Variables:Variables}>();app.use('*',async(c,next)=>{c.set('staffSubject','operator');await next();});app.route('/',createHealthDashboard(undefined,f.health as unknown as typeof readOperationalHealth));const publicFetch=vi.fn(()=>{throw Error('PUBLIC_FETCH_FORBIDDEN');});vi.stubGlobal('fetch',publicFetch);const v=await(await app.request('/',{}, {...f.env,HEALTH_MONITOR:{fetch:service} as unknown as Fetcher})).json();expect(v.monitoring.fresh).toBe(true);expect(service).toHaveBeenCalledOnce();expect(f.health).toHaveBeenCalledOnce();expect(publicFetch).not.toHaveBeenCalled();});

it('rejects redirects without following them using Workers-compatible manual mode',async()=>{const request=vi.fn(async(_url:string,init?:RequestInit)=>{expect(init?.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.example/'}});});await expect(dashboardJson('https://monitor.internal/status',{},request as typeof fetch)).rejects.toThrow('REDIRECT_REJECTED');expect(request).toHaveBeenCalledOnce();});
