import {applicationOrigin,initialState,observe,type Environment,type MonitorState} from './protocol';

export interface MetricsConfig {
 ENVIRONMENT:Environment;METRICS_ENABLED?:string;ANALYTICS_ACCOUNT_ID?:string;
 // A dedicated account-scoped Account Analytics / Read token, never the
 // deployment capability. No runtime fallback to another credential exists.
 CLOUDFLARE_ANALYTICS_READ_TOKEN?:string;
}
export type MetricsReadiness='not_configured'|'checking'|'ready'|'unavailable';
export interface MetricsState {
 v:1;startedAt:number|null;lastPollTick:number;checkedAt:number|null;
 readiness:MetricsReadiness;heartbeatLastAt:number|null;
 latency:MonitorState;errors:MonitorState;telemetry:MonitorState;authentication:MonitorState;recovery:MonitorState;
}
export const initialMetrics=():MetricsState=>({v:1,startedAt:null,lastPollTick:-1,checkedAt:null,readiness:'not_configured',heartbeatLastAt:null,latency:initialState(),errors:initialState(),telemetry:initialState(),authentication:initialState(),recovery:initialState()});
const routes=['/health','/api/v1/feed','/api/*','/api/auth/*','/api/account-recovery/*',...['sign-in/email','sign-up/email','sign-out','get-session','verify-email','request-password-reset','reset-password','send-verification-email','change-password','list-sessions','revoke-session','revoke-sessions'].map(route=>'/api/auth/'+route)];
const routeSet=new Set(routes);
export interface Aggregate {route:string;requests:number;observations:number;server_errors:number;failed_requests:number;p95_ms:number;latest:number}
export function metricsConfigured(env:MetricsConfig):boolean {
 return env.METRICS_ENABLED==='true'&&['staging','production'].includes(env.ENVIRONMENT)&&/^[a-f0-9]{32}$/.test(env.ANALYTICS_ACCOUNT_ID??'')&&/^[^\s]{32,256}$/.test(env.CLOUDFLARE_ANALYTICS_READ_TOKEN??'');
}
/** Everything interpolated is a checked enum or a compile-time constant. */
export function metricsQuery(environment:Environment):string {
 if(!['staging','production'].includes(environment))throw Error('METRICS_ENVIRONMENT');
 return `SELECT blob4 AS route, sum(_sample_interval) AS requests, count() AS observations,
 sum(if(double1>=500,_sample_interval,0)) AS server_errors,
 sum(if(double1>=400,_sample_interval,0)) AS failed_requests,
 quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms, max(timestamp) AS latest_timestamp
 FROM porchday_${environment}_operations_v1
 WHERE timestamp>NOW()-INTERVAL '15' MINUTE AND blob1='porchday_metrics_v1'
 AND blob2='${environment}' AND blob3='request'
 AND (blob5='GET' OR (blob4!='/health' AND blob4!='/api/v1/feed' AND blob5 IN ('POST','PUT','PATCH','DELETE')))
 AND blob4 IN (${routes.map(route=>`'${route}'`).join(',')})
 AND double1>=100 AND double1<=599 AND double2>=0 AND double2<=3600000
 AND _sample_interval>=1 AND _sample_interval<=1000000000
 GROUP BY route FORMAT JSON`;
}
async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>,milliseconds=6000):Promise<T> {
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('METRICS_TIMEOUT'));},milliseconds);})]);}
 finally{if(timer)clearTimeout(timer);controller.abort();}
}
async function readJson(response:Response):Promise<unknown> {
 if(!response.ok){await response.body?.cancel();throw Error('METRICS_RESPONSE');}
 const reader=response.body?.getReader();if(!reader)throw Error('METRICS_RESPONSE');
 const decoder=new TextDecoder();let text='',size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();throw Error('METRICS_RESPONSE');}text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode());}
 finally{reader.releaseLock();}
}
const number=(value:unknown,max=1e12):number=>{
 if(typeof value==='string'&&/^\d+(\.\d+)?$/.test(value)&&value.length<=32)value=Number(value);
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw Error('METRICS_RESPONSE');return value;
};
export function parseAggregates(value:unknown,now:number):Aggregate[] {
 const data=value&&typeof value==='object'?(value as {data?:unknown}).data:null;
 if(!Array.isArray(data)||data.length>routes.length)throw Error('METRICS_RESPONSE');
 const seen=new Set<string>();
 return data.map(row=>{
  if(!row||typeof row!=='object'||!routeSet.has(row.route)||seen.has(row.route))throw Error('METRICS_RESPONSE');seen.add(row.route);
  const requests=number(row.requests),observations=number(row.observations,1e9),server_errors=number(row.server_errors),failed_requests=number(row.failed_requests),p95_ms=number(row.p95_ms,3600000);
  if(!Number.isSafeInteger(requests)||!Number.isSafeInteger(observations)||!Number.isSafeInteger(server_errors)||!Number.isSafeInteger(failed_requests)||observations<1||requests<observations||server_errors>failed_requests||failed_requests>requests)throw Error('METRICS_RESPONSE');
  const stamp=row.latest_timestamp;
  if(typeof stamp!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?$/.test(stamp))throw Error('METRICS_RESPONSE');
  const latest=Date.parse(stamp.replace(' ','T').replace(/Z?$/,'Z'));
  if(!Number.isFinite(latest)||latest>now+60000||latest<now-15*60000-60000)throw Error('METRICS_RESPONSE');
  return{route:row.route,requests,observations,server_errors,failed_requests,p95_ms,latest};
 });
}
export async function readMetrics(env:MetricsConfig,now:number,request:typeof fetch=fetch):Promise<Aggregate[]|null> {
 if(!metricsConfigured(env))return null;
 try{return await bounded(async signal=>parseAggregates(await readJson(await request(`https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`,{
  method:'POST',headers:{Authorization:'Bearer '+env.CLOUDFLARE_ANALYTICS_READ_TOKEN,'Content-Type':'text/plain'},body:metricsQuery(env.ENVIRONMENT),redirect:'manual',signal,
 })),now));}catch{return null;}
}
export async function heartbeat(environment:Environment,request:typeof fetch=fetch):Promise<boolean> {
 if(!['staging','production'].includes(environment))return false;
 try{return await bounded(async signal=>{
  const value=await readJson(await request(`${applicationOrigin(environment)}/health`,{method:'GET',redirect:'manual',cache:'no-store',signal}));
  return !!value&&typeof value==='object'&&(value as any).status==='ok'&&(value as any).service==='porchday'&&(value as any).environment===environment;
 });}catch{return false;}
}
/** Unknown/insufficient evidence cannot clear an incident or count as a
 * healthy sample. It also breaks a sequence of consecutive bad/good polls. */
function uncertain(previous:MonitorState):MonitorState{return{...previous,failures:0,successes:0};}
export function performanceSignals(rows:Aggregate[]):{latency:boolean|null;errors:boolean|null} {
 const feed=rows.find(row=>row.route==='/api/v1/feed');
 const api=rows.filter(row=>row.route!=='/health');
 const count=api.reduce((sum,row)=>sum+row.requests,0),observations=api.reduce((sum,row)=>sum+row.observations,0),errors=api.reduce((sum,row)=>sum+row.server_errors,0);
 const enoughFeed=!!feed&&feed.requests>=100&&feed.observations>=20;
 const enoughApi=count>=100&&observations>=20;
 // Separate objectives let an auth-only error incident recover using auth
 // traffic; a feed-latency incident still requires enough new feed evidence.
 return{latency:enoughFeed?feed!.p95_ms<=500:null,errors:enoughApi?!(errors>=5&&errors/count>=0.01):null};
}
/** Aggregate operational warning only: expected invalid/expired credentials
 * also return 4xx. Never identify a person or automatically hold/block accounts. */
export function securitySignals(rows:Aggregate[]):{authentication:boolean|null;recovery:boolean|null} {
 const authRoutes=new Set(['/api/auth/sign-in/email','/api/auth/reset-password','/api/auth/verify-email','/api/auth/*']);
 const signal=(selected:Aggregate[])=>{
  const requests=selected.reduce((n,r)=>n+r.requests,0),observations=selected.reduce((n,r)=>n+r.observations,0),failures=selected.reduce((n,r)=>n+r.failed_requests,0);
  return requests>=100&&observations>=20?!(failures>=20&&failures/requests>=0.20):null;
 };
 return{authentication:signal(rows.filter(row=>authRoutes.has(row.route))),recovery:signal(rows.filter(row=>row.route==='/api/account-recovery/*'))};
}
export async function checkMetrics(previous:MetricsState,env:MetricsConfig,now:number,tick:number,request:typeof fetch=fetch):Promise<MetricsState> {
 const state=structuredClone(previous);
 // Additive upgrade of persisted v1 state; existing incidents are retained.
 state.authentication??=initialState();state.recovery??=initialState();
 if(!metricsConfigured(env)){
  // Do not keep retrying stale performance alerts after an explicit disable.
  return initialMetrics();
 }
 state.startedAt??=now;
 const poll=state.lastPollTick<0||tick-state.lastPollTick>=5;
 const [alive,rows]=await Promise.all([heartbeat(env.ENVIRONMENT,request),poll?readMetrics(env,now,request):Promise.resolve(undefined)]);
 if(alive)state.heartbeatLastAt=now;
 if(!poll)return state;
 state.lastPollTick=tick;state.checkedAt=now;
 const latest=rows?.find(row=>row.route==='/health')?.latest;
 const fresh=latest!==undefined&&now-latest<=5*60000&&state.heartbeatLastAt!==null&&now-state.heartbeatLastAt<=2*60000;
 // Even an unused pilot produces one heartbeat/minute. A missing heartbeat
 // can never be classified as idle member traffic or used to clear an alert.
 const warming=rows!==null&&!fresh&&now-state.startedAt<5*60000;
 state.readiness=rows===null?'unavailable':fresh?'ready':warming?'checking':'unavailable';
 state.telemetry=warming?uncertain(state.telemetry):observe(state.telemetry,state.readiness==='ready',now,tick);
 const signals=rows&&fresh?performanceSignals(rows):{latency:null,errors:null};
 for(const channel of ['latency','errors'] as const)state[channel]=signals[channel]===null?uncertain(state[channel]):observe(state[channel],signals[channel]!,now,tick);
 const security=rows&&fresh?securitySignals(rows):{authentication:null,recovery:null};
 for(const channel of ['authentication','recovery'] as const)state[channel]=security[channel]===null?uncertain(state[channel]):observe(state[channel],security[channel]!,now,tick);
 return state;
}
export function publicMetrics(state:MetricsState,now=Date.now()):MetricsReadiness {
 if(state.readiness==='not_configured')return 'not_configured';
 return state.checkedAt===null||now-state.checkedAt>7*60000?'unavailable':state.readiness;
}
export function metricsAlertText(environment:Environment,channel:'latency'|'errors'|'telemetry'|'authentication'|'recovery',kind:'outage'|'recovery') {
 const recovered=kind==='recovery';
 if(channel==='authentication'||channel==='recovery'){
  const label=channel==='authentication'?'authentication failures':'account-recovery failures';
  return{subject:`Porchday ${environment}: ${label} ${recovered?'recovered':'need attention'}`,text:`Porchday ${environment} ${recovered?'passed two':'failed three'} consecutive five-minute ${label} polls. Each 15-minute window requires at least 100 weighted requests and 20 observed rows. Attention means at least 20 HTTP 4xx/5xx responses and a failure proportion of 20% or more. These are provisional aggregate review thresholds, not evidence of a compromised account; invalid or expired links and rate limits count too. Inspect private aggregate metrics and authorized support queues. Idle or insufficient traffic cannot establish recovery. No account action is automatic.`};
 }
 const label=channel==='latency'?'feed latency':channel==='errors'?'API error checks':'metrics monitoring';
 const text=channel==='telemetry'
  ?`Porchday ${environment} metrics monitoring ${recovered?'passed two':'failed three'} consecutive five-minute polls. A healthy metrics check requires a successful bounded query and a GET /health observation within five minutes. Query or ingestion failure means monitoring is unavailable; this does not itself establish an application outage. Inspect the private monitoring configuration and aggregate metrics.`
  :`Porchday ${environment} ${recovered?'passed two':'failed three'} consecutive five-minute ${label} polls with adequate request samples. The 15-minute objective is ${channel==='latency'?'feed p95 at most 500 ms':'application 5xx below 1%, with at least five errors before alerting'}. Inspect the private aggregate metrics. These estimates exclude network transfer and client decryption.`;
 return{subject:`Porchday ${environment}: ${label} ${recovered?'recovered':'need attention'}`,text};
}
