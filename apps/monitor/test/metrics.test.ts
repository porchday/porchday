import {afterEach,describe,expect,it,vi} from 'vitest';
import {checkMetrics,heartbeat,initialMetrics,metricsConfigured,metricsQuery,parseAggregates,performanceSignals,securitySignals,metricsAlertText,publicMetrics,readMetrics,type MetricsConfig} from '../src/metrics';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const now=Date.UTC(2026,9,25,12);
const env:MetricsConfig={ENVIRONMENT:'staging',METRICS_ENABLED:'true',ANALYTICS_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_ANALYTICS_READ_TOKEN:'synthetic-read-only-capability-123456789'};
const row=(route='/api/v1/feed',overrides:Record<string,unknown>={})=>({route,requests:'200',observations:100,server_errors:0,failed_requests:overrides.server_errors??0,p95_ms:100,latest_timestamp:new Date(Date.now()).toISOString(),...overrides});
const response=(rows:unknown[])=>Response.json({data:rows});
const beat=()=>Response.json({status:'ok',service:'porchday',environment:'staging'});

describe('Bounded private aggregate metrics consumer',()=>{
 it('uses only fixed SQL, sampling weights, validated account/environment and a dedicated read capability',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const fetcher=vi.fn().mockResolvedValue(response([row()]));
  expect(await readMetrics(env,now,fetcher)).toEqual([{route:'/api/v1/feed',requests:200,observations:100,server_errors:0,failed_requests:0,p95_ms:100,latest:now}]);
  const [url,options]=fetcher.mock.calls[0];
  expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/analytics_engine/sql');
  expect(options).toMatchObject({method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+env.CLOUDFLARE_ANALYTICS_READ_TOKEN}});
  expect(options.body).toBe(metricsQuery('staging'));
  expect(options.body).toContain('sum(_sample_interval)');expect(options.body).toContain('count() AS observations');expect(options.body).toContain('quantileExactWeighted(0.95)(double2,_sample_interval)');
  expect(options.body).not.toContain('/api/operations/health');expect(options.body).toContain("blob2='staging'");expect(options.body).toContain("blob5 IN ('POST','PUT','PATCH','DELETE')");expect(options.body).not.toContain(env.CLOUDFLARE_ANALYTICS_READ_TOKEN);
  const broad={...env,CLOUDFLARE_ANALYTICS_READ_TOKEN:undefined,CLOUDFLARE_API_TOKEN:'private-broad-deployment-secret'};
  expect(metricsConfigured(broad)).toBe(false);expect(await readMetrics(broad,now,fetcher)).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readMetrics({...env,ANALYTICS_ACCOUNT_ID:'../../other'},now,fetcher)).toBeNull();
  expect(()=>metricsQuery('private-injected SQL' as any)).toThrow('METRICS_ENVIRONMENT');
 });
 it('rejects redirects without following the query or heartbeat target',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>new Response(null,{status:307,headers:{Location:'https://attacker.test'}}));
  expect(await readMetrics(env,Date.now(),fetcher)).toBeNull();expect(await heartbeat('staging',fetcher)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);for(const [,options] of fetcher.mock.calls)expect(options.redirect).toBe('manual');
 });
 it('limits body bytes and rejects malformed, excessive, duplicate or contradictory sample evidence',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const fetcher=vi.fn().mockResolvedValue(new Response('private-provider-diagnostic',{status:403}));expect(await readMetrics(env,now,fetcher)).toBeNull();
  fetcher.mockResolvedValue(new Response('a'.repeat(16385)));expect(await readMetrics(env,now,fetcher)).toBeNull();
  for(const bad of [{requests:1,observations:20},{requests:200,server_errors:201},{failed_requests:201},{server_errors:10,failed_requests:9},{failed_requests:0.5},{requests:'Infinity'},{observations:0},{observations:1.5},{p95_ms:-1},{route:'/private/member/id'},{latest_timestamp:'invalid private token'},{latest_timestamp:new Date(now+120000).toISOString()}])expect(()=>parseAggregates({data:[row('/api/v1/feed',bad)]},now)).toThrow('METRICS_RESPONSE');
  expect(()=>parseAggregates({data:[row(),row()]},now)).toThrow();expect(()=>parseAggregates({data:Array(33).fill(row())},now)).toThrow();
  expect(parseAggregates({data:[row('/health',{latest_timestamp:'2026-10-25 12:00:00',provider_debug:'private-response'})]},now)[0].latest).toBe(now);
 });
 it('times out queries and heartbeats even if transport ignores abort, with no fallback credentials',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));
  const pending=readMetrics(env,now,fetcher);await vi.advanceTimersByTimeAsync(6001);expect(await pending).toBeNull();expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  const alive=heartbeat('staging',fetcher);await vi.advanceTimersByTimeAsync(6001);expect(await alive).toBe(false);expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
 });
 it('requires an adequate weighted AND observed sample, excludes synthetic health, and separates recovery objectives',()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const parsed=(rows:unknown[])=>parseAggregates({data:rows},now);
  expect(performanceSignals(parsed([row('/health',{requests:10000,observations:10000}),row('/api/auth/sign-in/email',{requests:100,server_errors:5})]))).toEqual({latency:null,errors:false});
  expect(performanceSignals(parsed([row('/api/auth/sign-in/email',{requests:100,server_errors:0})]))).toEqual({latency:null,errors:true});
  expect(performanceSignals(parsed([row('/api/v1/feed',{requests:10000,observations:1,server_errors:10000,p95_ms:900})]))).toEqual({latency:null,errors:null});
  expect(performanceSignals(parsed([row('/api/v1/feed',{requests:100,server_errors:4,p95_ms:501})]))).toEqual({latency:false,errors:true});
  expect(performanceSignals(parsed([row('/api/v1/feed',{requests:1000,server_errors:9,p95_ms:500})]))).toEqual({latency:true,errors:true});
 });
 it('produces one fixed heartbeat each minute, queries every five, and detects missing ingestion even with no members',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/health')?beat():response([]));let state=initialMetrics();
  for(let minute=0;minute<=15;minute++){
   vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);
   if(minute===0)expect(state.readiness).toBe('checking');
   if(minute===10)expect(state.telemetry.pending).toBeNull();
  }
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/health'))).toHaveLength(16);
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/sql'))).toHaveLength(4);
  expect(state.readiness).toBe('unavailable');expect(state.telemetry.pending?.kind).toBe('outage');expect(state.latency.status).toBe('checking');expect(state.errors.status).toBe('checking');
  expect(JSON.stringify(state)).not.toContain(env.CLOUDFLARE_ANALYTICS_READ_TOKEN);
  fetcher.mockImplementation(async(url)=>String(url).endsWith('/health')?beat():response([row('/health')]));
  for(const minute of [20,25]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.readiness).toBe('ready');expect(state.telemetry.status).toBe('operational');expect(state.latency.status).toBe('checking');
  expect(publicMetrics(state,now+33*60000)).toBe('unavailable');
 });
 it('keeps application error and latency incidents independent, and insufficient evidence cannot recover an incident',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);let bad=true,thin=false;
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/health')?beat():response([row('/health'),row('/api/auth/sign-in/email',{server_errors:bad?10:0,observations:thin?1:100})]));
  let state=initialMetrics();
  for(const minute of [0,5,10]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.errors.status).toBe('degraded');expect(state.errors.pending?.kind).toBe('outage');expect(state.latency.pending).toBeNull();
  state.errors.outageDelivered=true;state.errors.pending=null;bad=false;thin=true;
  for(const minute of [15,20]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.errors.status).toBe('degraded');expect(state.errors.pending).toBeNull();thin=false;
  for(const minute of [25,30]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.errors.status).toBe('operational');expect(state.errors.pending?.kind).toBe('recovery');expect(state.latency.pending).toBeNull();
 });
 it('does no I/O when optional metrics are disabled or incomplete and makes not-ready explicit',async()=>{
  const fetcher=vi.fn();
  for(const config of [{...env,METRICS_ENABLED:'false'},{...env,CLOUDFLARE_ANALYTICS_READ_TOKEN:undefined}]){
   const state=await checkMetrics(initialMetrics(),config,now,1,fetcher);expect(publicMetrics(state,now)).toBe('not_configured');
  }
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('keeps aggregate credential/link failures separate, with both sample floors and no false idle recovery',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const parse=(rows:unknown[])=>parseAggregates({data:rows},Date.now());
  expect(securitySignals(parse([row('/api/auth/get-session',{failed_requests:200})]))).toEqual({authentication:null,recovery:null});
  expect(securitySignals(parse([row('/api/auth/sign-in/email',{requests:100,failed_requests:20}),row('/api/account-recovery/*',{requests:100,failed_requests:19})]))).toEqual({authentication:false,recovery:true});
  expect(securitySignals(parse([row('/api/account-recovery/*',{requests:10000,observations:1,failed_requests:10000})]))).toEqual({authentication:null,recovery:null});
  let mode:'bad'|'thin'|'good'='bad';
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/health')?beat():response([row('/health'),row('/api/account-recovery/*',{requests:100,observations:mode==='thin'?1:50,failed_requests:mode==='bad'?20:0}),row('/api/auth/sign-in/email',{requests:100,failed_requests:0})]));
  const legacy=initialMetrics();delete (legacy as any).authentication;delete (legacy as any).recovery;
  let state=legacy;
  for(const minute of [0,5,10]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.recovery.status).toBe('degraded');expect(state.recovery.pending?.kind).toBe('outage');expect(state.authentication.status).toBe('operational');
  state.recovery.outageDelivered=true;state.recovery.pending=null;mode='thin';
  for(const minute of [15,20]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.recovery.status).toBe('degraded');expect(state.recovery.pending).toBeNull();mode='good';
  for(const minute of [25,30]){vi.setSystemTime(now+minute*60000);state=await checkMetrics(state,env,Date.now(),minute,fetcher);}
  expect(state.recovery.status).toBe('operational');expect(state.recovery.pending?.kind).toBe('recovery');
  const notice=metricsAlertText('staging','recovery','outage');expect(notice.text).toContain('No account action is automatic');expect(JSON.stringify(notice)).not.toContain(env.CLOUDFLARE_ANALYTICS_READ_TOKEN);
 });
});
