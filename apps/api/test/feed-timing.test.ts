import {requestTimingMiddleware} from '../src/request-timing';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {feedTiming,measureFeedPhase} from '../src/feed-timing';
import {event,FEED_PHASES} from '../src/telemetry';
import {privacyReadGuard} from '../src/privacy-journal';
import {requireMember} from '../src/session';
import {createSocialRoutes} from '../src/social';
import type {Env,Variables} from '../src/types';

// Exercise the real middleware/handler sequence with deterministic external
// adapters. Existing database integration suites separately exercise actual RLS.
const fixture=vi.hoisted(()=>({trace:[] as string[],quarantined:false,verified:true,status:'active',queryFailure:false,journalFailure:false,
 member:'11111111-1111-4111-8111-111111111111',generation:'22222222-2222-4222-8222-222222222222'}));
vi.mock('postgres',()=>({default:(connection:string)=>{
 const sql=async(strings:TemplateStringsArray,..._values:unknown[])=>{
  // postgres.js composes this empty cursor fragment without executing a query.
  if(!strings.join('').trim())return [];
  if(connection==='synthetic-jobs'){
   fixture.trace.push('journal_status');
   if(fixture.journalFailure)throw Error('private SQL connection and parameters');
   return [{value:{generation:fixture.generation,sequence:'0',quarantined:fixture.quarantined}}];
  }
  if(strings.join('').includes('set_config')){fixture.trace.push('actor');return [];}
  fixture.trace.push('query');
  if(fixture.queryFailure)throw Object.assign(Error('private SQL failure'),{code:'42501'});
  return [];
 };
 sql.begin=async(work:(db:typeof sql)=>Promise<unknown>)=>{
  fixture.trace.push('begin');
  try{const value=await work(sql);fixture.trace.push('commit');return value;}
  catch(error){fixture.trace.push('rollback');throw error;}
 };
 sql.end=async()=>{fixture.trace.push(connection==='synthetic-jobs'?'journal_close':'social_close');};
 return sql;
}}));
vi.mock('pg',()=>({Pool:class {
 async connect(){return {query:async(text:string)=>{
  if(text.startsWith('BEGIN')){fixture.trace.push('begin','actor');return {rows:[]};}
  if(text==='COMMIT'||text==='ROLLBACK'){fixture.trace.push(text.toLowerCase());return {rows:[]};}
  fixture.trace.push('query');if(fixture.queryFailure)throw Error('private query failure');fixture.trace.push('commit');return [{rows:[]},{command:'COMMIT'}];
 },release:()=>{}};}
 async end(){fixture.trace.push('social_close');}
}}));
vi.mock('../src/auth',()=>({
 authPool:()=>({query:async()=>{fixture.trace.push('auth_status');return {rows:[{status:fixture.status}]};},end:async()=>{fixture.trace.push('auth_close');}}),
 createAuth:()=>({api:{getSession:async()=>{fixture.trace.push('auth_session');return {user:{id:fixture.member,emailVerified:fixture.verified},session:{id:'33333333-3333-4333-8333-333333333333',createdAt:new Date()}};}}}),
}));
beforeEach(()=>{fixture.trace=[];fixture.quarantined=false;fixture.verified=true;fixture.status='active';fixture.queryFailure=false;fixture.journalFailure=false;});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

function setup(overrides:Partial<Env>={}, path='/api/v1/feed'){
 const points:AnalyticsEngineDataPoint[]=[],pending:Promise<unknown>[]=[];
 const env={ENVIRONMENT:'staging',FEED_PHASE_TIMING:'true',METRICS:{writeDataPoint:(point:AnalyticsEngineDataPoint)=>{points.push(point);}},
  HYPERDRIVE_JOBS:{connectionString:'synthetic-jobs'},HYPERDRIVE_SOCIAL:{connectionString:'synthetic-social'},
  RECOVERY_JOURNAL:{get:async(key:string)=>{if(key.startsWith('session-denials/v1/')){fixture.trace.push('session_denial_read');return null;}fixture.trace.push('journal_read');return {etag:'private-etag',text:async()=>JSON.stringify({v:1,generation:fixture.generation,mode:'active',sequence:'0',head:null,pending:[],reason:null})};}},...overrides} as unknown as Env;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',requestTimingMiddleware);app.use('/api/*',privacyReadGuard);app.use('/api/v1/*',requireMember);app.route('/api/v1',createSocialRoutes());
 const request=()=>app.request('https://staging.porchday.test'+path+'?private-token=secret',{headers:{Cookie:'session=private-cookie'}},env,{waitUntil:(promise:Promise<unknown>)=>pending.push(promise),passThroughOnException(){}} as ExecutionContext);
 return {env,points,pending,request};
}

test('all nine fixed phases cover the actual feed path without changing checks, identity or response headers',async()=>{
 const {request,points,pending}=setup();
 const response=await request();await Promise.all(pending);
 expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[],next_cursor:null});
 expect(fixture.trace).toEqual(['journal_read','journal_status','journal_close','auth_session','auth_status','begin','actor','query','commit','social_close','auth_close']);
 expect(points.map(p=>p.blobs?.[5])).toEqual(FEED_PHASES);
 expect(points.every(p=>p.indexes?.[0]==='feed_phase:/api/v1/feed'&&p.blobs?.length===7&&p.doubles?.length===3&&p.doubles[0]===0&&p.doubles[1]>=0&&p.doubles[2]===0)).toBe(true);
 expect(JSON.stringify(points)).not.toMatch(/private|secret|11111111|22222222|synthetic-/);
 expect([...response.headers.keys()]).not.toContain('server-timing');
 expect([...response.headers.keys()].some(name=>/phase|timing/.test(name))).toBe(false);
});

test('every request repeats fresh privacy and member checks, and denial never runs the feed query',async()=>{
 const {request,points}=setup();expect((await request()).status).toBe(200);
 fixture.trace=[];points.length=0;fixture.quarantined=true;
 expect((await request()).status).toBe(503);
 expect(fixture.trace).toEqual(['journal_read','journal_status','journal_close']);
 expect(points.filter(p=>p.blobs?.[2]==='feed_phase').map(p=>p.blobs?.[5])).toEqual(['journal_check','journal_close']);
 fixture.quarantined=false;fixture.status='hold';fixture.trace=[];points.length=0;
 expect((await request()).status).toBe(403);
 expect(fixture.trace).toEqual(['journal_read','journal_status','journal_close','auth_session','auth_status','auth_close']);
 expect(points.some(p=>String(p.blobs?.[5]).startsWith('social_'))).toBe(false);
});

test('journal boundary failures emit only fixed source codes and never reach auth or the feed',async()=>{
 vi.useFakeTimers();
 for(const kind of ['store','control','database']){
  fixture.trace=[];fixture.journalFailure=kind==='database';
  const overrides=kind==='database'?{}:{RECOVERY_JOURNAL:{get:async()=>{
   if(kind==='store')throw Error('private R2 endpoint token=hidden');
   return {etag:'private-etag',text:async()=>'{private-invalid-content'};
  }} as unknown as R2Bucket};
  const {request,points}=setup(overrides);const pending=request();await vi.runAllTimersAsync();const response=await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:{code:'PRIVACY_CHECKPOINT_REQUIRED',message:'Porchday could not complete a required safety check. Please try again shortly.'}});
  expect(points.filter(p=>p.blobs?.[2]==='error').map(p=>p.blobs?.[5])).toEqual(kind==='store'?['journal_r2_read_retry','journal_r2_read_retry','journal_r2_read_retry','journal_io_exhausted','journal_store_read_failed']:[kind==='control'?'journal_control_invalid':'journal_database_read_failed']);
  expect(fixture.trace).not.toContain('auth_session');expect(fixture.trace).not.toContain('begin');expect(fixture.trace).toContain('journal_close');
  expect(JSON.stringify(points)).not.toMatch(/private|hidden|parameters|endpoint/);
 }
});

test('query rejection still rolls back and closes; timing never reports a successful commit',async()=>{
 fixture.queryFailure=true;const {request,points}=setup();
 expect((await request()).status).toBe(403);
 expect(fixture.trace).toContain('rollback');expect(fixture.trace).not.toContain('commit');expect(fixture.trace).toContain('social_close');
 const phases=points.map(p=>p.blobs?.[5]);expect(phases).toContain('social_query');expect(phases).toContain('social_close');expect(phases).not.toContain('social_commit');
 expect(JSON.stringify(points)).not.toContain('private SQL failure');
});

test('production and disabled staging preserve the same feed work without timing points',async()=>{
 for(const overrides of [{ENVIRONMENT:'production' as const},{FEED_PHASE_TIMING:undefined},{FEED_PHASE_TIMING:'false'}]){
  fixture.trace=[];const {request,points}=setup(overrides);expect((await request()).status).toBe(200);expect(points).toHaveLength(0);expect(fixture.trace).toContain('actor');expect(fixture.trace).toContain('commit');
 }
 const env=setup().env;
 for(const [method,path] of [['POST','/api/v1/feed'],['GET','/api/v1/feed/private-member'],['GET','/api/v1/posts'],['GET','/api/v1/feed?token=private']])expect(feedTiming(env,method,path)).toBeUndefined();
});

test('central writer independently rejects unknown phases and production; accepted phase drops all extra fields',()=>{
 const {env,points}=setup();const log=vi.spyOn(console,'log').mockImplementation(()=>{});
 const fields={route:'/api/v1/feed',method:'GET',code:'social_query',durationMs:12.5,status:500,count:3,memberId:'private-member',token:'private-token',environment:'production'};
 event('feed_phase',fields,env);
 expect(points).toEqual([{indexes:['feed_phase:/api/v1/feed'],blobs:['porchday_metrics_v1','staging','feed_phase','/api/v1/feed','GET','social_query','none'],doubles:[0,13,0]}]);
 for(const code of ['private-member','accepted','request_failed'])event('feed_phase',{...fields,code},env);
 for(const durationMs of [-1,NaN,Infinity,3_600_001])event('feed_phase',{...fields,durationMs},env);
 event('feed_phase',fields,{...env,ENVIRONMENT:'production'});event('feed_phase',fields,{...env,FEED_PHASE_TIMING:undefined});
 event('feed_phase',{...fields,route:'/api/v1/feed/private-token'},env);
 expect(points).toHaveLength(1);expect(log).not.toHaveBeenCalled();
});

test('failed timing sinks preserve operation values, original failures, and actual feed cleanup',async()=>{
 const broken={record(){throw Error('private telemetry failure');}};
 await expect(measureFeedPhase(broken,'auth_session',async()=>42)).resolves.toBe(42);
 const original=Error('original failure');await expect(measureFeedPhase(broken,'social_query',async()=>{throw original;})).rejects.toBe(original);
 const {request}=setup({METRICS:{writeDataPoint(){throw Error('private sink failure');}}});
 expect((await request()).status).toBe(200);expect(fixture.trace).toContain('commit');expect(fixture.trace).toContain('social_close');
});


test('authenticated me exposes only fixed numeric phases; denials expose none and repeat fresh checks',async()=>{
 const {request,points}=setup({ENVIRONMENT:'production'},'/api/v1/me');
 const response=await request();expect(response.status).toBe(200);
 const header=response.headers.get('server-timing')!;
 const names=header.split(', ').map(value=>{expect(value).toMatch(/^[a-z0-9_]+;dur=[0-9]+$/);return value.split(';')[0];});
 expect(names).toEqual([...FEED_PHASES.filter(phase=>phase!=='social_actor'&&phase!=='social_commit'),'journal_r2','journal_db','worker']);
 expect(header).not.toMatch(/private|secret|11111111|22222222|synthetic/);
 expect(points).toHaveLength(0);
 expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(response.headers.has('timing-allow-origin')).toBe(false);
 fixture.trace=[];fixture.verified=false;
 const denied=await request();expect(denied.status).toBe(401);expect(denied.headers.has('server-timing')).toBe(false);
 expect(fixture.trace).toContain('journal_read');expect(fixture.trace).toContain('auth_session');expect(fixture.trace).not.toContain('query');
 fixture.verified=true;fixture.quarantined=true;
 const quarantined=await request();expect(quarantined.status).toBe(503);expect(quarantined.headers.has('server-timing')).toBe(false);
});
