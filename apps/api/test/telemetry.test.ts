import {test,expect,vi} from 'vitest';
import {event,normalizedRoute} from '../src/telemetry';
import {app} from '../src/index';
import {sendAccountEmail} from '../src/email';
import type {Env} from '../src/types';
test('telemetry drops identifiers, secret-like strings and arbitrary payload fields even on failures',()=>{
 const spy=vi.spyOn(console,'log').mockImplementation(()=>{});
 try{
  event('error',{code:'private-secret-token-should-never-appear',route:'/api/posts/4dc907ef-5906-47da-9214-84bbd9f5fb22?key=secret',environment:'member@example.test',message:'private text',password:'secret',body:'private media',status:500} as never);
  const serialized=spy.mock.calls.map(x=>x[0]).join('');
  expect(JSON.parse(serialized)).toEqual({event:'error',status:500});
  expect(normalizedRoute('/api/auth/reset-password/secret-token?token=secret')).toBe('/api/auth/*');
 }finally{spy.mockRestore();}
});
test('unavailable telemetry never fails the application operation',()=>{
 const spy=vi.spyOn(console,'log').mockImplementation(()=>{throw Error('transport down');});
 try{expect(()=>event('job',{code:'cleanup_complete',count:3})).not.toThrow();}finally{spy.mockRestore();}
});

test('Analytics Engine receives only finite dimensions and bounded numbers, with no hosted console output',()=>{
 const writeDataPoint=vi.fn(),consoleOutput=vi.spyOn(console,'log').mockImplementation(()=>{});
 try{
  const env={ENVIRONMENT:'production',METRICS:{writeDataPoint}} as Env;
  event('request',{route:'/api/v1/feed',method:'GET',status:200,durationMs:12.6,count:3,environment:'staging',memberId:'private-member',token:'private-token',body:'secret post'} as never,env);
  expect(writeDataPoint.mock.calls[0][0]).toEqual({indexes:['request:/api/v1/feed'],blobs:['porchday_metrics_v1','production','request','/api/v1/feed','GET','none','2xx'],doubles:[200,13,3]});
  event('error',{route:'/api/posts/private-id?token=private-token',method:'PRIVATE',status:1e9,durationMs:Infinity,count:1.5,code:'user@example.test'} as never,env);
  const point=writeDataPoint.mock.calls[1][0];
  expect(point).toEqual({indexes:['error:none'],blobs:['porchday_metrics_v1','production','error','none','none','none','none'],doubles:[0,-1,0]});
  expect(JSON.stringify(writeDataPoint.mock.calls)).not.toMatch(/private|example\.test|secret post/);
  expect(consoleOutput).not.toHaveBeenCalled();
  event('private-event-name' as never,{},env);expect(writeDataPoint).toHaveBeenCalledTimes(2);
 }finally{consoleOutput.mockRestore();}
});

test('binding state is explicit per environment and neither absent nor failed metrics delay operations',async()=>{
 const staging=vi.fn(),production=vi.fn();
 event('job',{code:'cleanup_complete',count:4},{ENVIRONMENT:'staging',METRICS:{writeDataPoint:staging}});
 event('email',{code:'outbox_retry',count:2},{ENVIRONMENT:'production',METRICS:{writeDataPoint:production}});
 expect(staging.mock.calls[0][0].blobs[1]).toBe('staging');expect(production.mock.calls[0][0].blobs[1]).toBe('production');
 expect(staging).toHaveBeenCalledTimes(1);expect(production).toHaveBeenCalledTimes(1);
 expect(()=>event('error',{code:'request_failed'},{ENVIRONMENT:'production'})).not.toThrow();
 expect(()=>event('error',{}, {ENVIRONMENT:'production',METRICS:{writeDataPoint(){throw Error('transport down');}}})).not.toThrow();
 const pending=new Promise<void>(()=>{});
 expect(event('error',{}, {ENVIRONMENT:'production',METRICS:{writeDataPoint:()=>pending}})).toBeUndefined();
 expect(event('error',{}, {ENVIRONMENT:'production',METRICS:{writeDataPoint:()=>Promise.reject(Error('adapter down'))}})).toBeUndefined();
 await Promise.resolve();await Promise.resolve();
 expect(()=>event('error',{}, {ENVIRONMENT:'production',get METRICS(){throw Error('missing runtime binding');}})).not.toThrow();
});

test('normalization separates fixed health probes, feed, auth actions and generic route classes',()=>{
 expect(normalizedRoute('/api/operations/health')).toBe('/api/operations/health');
 expect(normalizedRoute('/api/v1/feed')).toBe('/api/v1/feed');
 expect(normalizedRoute('/api/auth/sign-in/email')).toBe('/api/auth/sign-in/email');
 for(const path of ['/api/auth/reset-password/private-token','/api/auth/verify-email?token=private-token'])expect(normalizedRoute(path)).toBe('/api/auth/*');
 for(const path of ['/api/v1/posts/private-id','/api/v1/profiles/private-handle'])expect(normalizedRoute(path)).toBe('/api/*');
 expect(normalizedRoute('/api/account-recovery/verify-contact?token=private-token')).toBe('/api/account-recovery/*');
 expect(normalizedRoute('/app/reset?token=private-token')).toBe('/assets/*');
});

test('actual request middleware records status and latency without URL, cookie, body, request ID or exception text',async()=>{
 const points:AnalyticsEngineDataPoint[]=[];
 const env={ENVIRONMENT:'production',APP_URL:'https://porchday.test',METRICS:{writeDataPoint:(point:AnalyticsEngineDataPoint)=>{points.push(point);}},ASSETS:{fetch:async()=>{throw Error('private provider failure with token=hidden');}}} as unknown as Env;
 const health=await app.request('https://porchday.test/health?token=private-token',{headers:{Cookie:'session=private-cookie',Authorization:'Bearer private-auth'}},env);
 expect(health.status).toBe(200);expect(points.at(-1)?.blobs).toEqual(['porchday_metrics_v1','production','request','/health','GET','none','2xx']);
 const denied=await app.request('https://porchday.test/api/auth/reset-password/private-link?token=private-token',{method:'POST',headers:{Origin:'https://wrong.example'},body:'private-password'},env);
 expect(denied.status).toBe(403);expect(points.at(-1)?.blobs?.[3]).toBe('/api/auth/*');expect(points.at(-1)?.doubles?.[0]).toBe(403);
 const tooLarge=await app.request('https://porchday.test/api/v1/posts',{method:'POST',headers:{Origin:env.APP_URL,'Content-Length':String(25*1024*1024+1)},body:'synthetic'},env);
 expect(tooLarge.status).toBe(413);expect(points.at(-1)?.doubles?.[0]).toBe(413);
 const failed=await app.request('https://porchday.test/private-path?token=hidden',{},env);
 expect(failed.status).toBe(503);expect(points.at(-1)?.blobs?.[3]).toBe('/assets/*');
 expect(JSON.stringify(points)).not.toMatch(/private-|hidden|provider failure|wrong\.example/);
 expect(JSON.stringify(points)).not.toContain(health.headers.get('x-request-id')!);
 expect(points.every(p=>(p.indexes?.length??0)===1&&String(p.indexes![0]).length<=96&&(p.blobs?.length??0)===7)).toBe(true);
 const broken={...env,METRICS:{writeDataPoint(){throw Error('unavailable');}}};
 expect((await app.request('https://porchday.test/health',{},broken)).status).toBe(200);
});

test('actual transactional-email adapter emits delivery outcomes without address, subject, link or body',async()=>{
 const writeDataPoint=vi.fn(),env={ENVIRONMENT:'production',METRICS:{writeDataPoint},EMAIL_FROM:'synthetic@example.test',EMAIL:{send:async()=>{}}} as unknown as Env;
 await sendAccountEmail(env,'private-person@example.test','private subject','https://example.test/reset?token=private-token');
 expect(writeDataPoint.mock.calls[0][0].blobs[5]).toBe('accepted');
 env.EMAIL={send:async()=>{throw Error('private provider error');}} as never;
 await expect(sendAccountEmail(env,'private-person@example.test','private subject','private body')).rejects.toThrow('EMAIL_UNAVAILABLE');
 expect(writeDataPoint.mock.calls[1][0].blobs[5]).toBe('send_failed');expect(JSON.stringify(writeDataPoint.mock.calls)).not.toMatch(/private|example\.test/);
});

test('connection events accept route patterns and job labels but never concrete paths',()=>{
 const writeDataPoint=vi.fn();
 const env={ENVIRONMENT:'production',METRICS:{writeDataPoint}} as Env;
 event('db_conn',{route:'/api/v1/media/:id/bytes',code:'social_close',durationMs:40,count:1,detailMs:12},env);
 event('db_conn',{route:'/api/v1/media/4dc907ef-5906-47da-9214-84bbd9f5fb22/bytes',code:'social_close'},env);
 event('db_snapshot',{route:'job:cron',code:'jobs_idle_in_transaction',count:3,durationMs:65000},env);
 event('db_conn',{route:'/api/v1/media/:id/bytes',code:'member@example.test'},env);
 event('request',{route:'/api/v1/media/:id/bytes',method:'GET',status:200},env);
 const [a,b,c,d,e]=writeDataPoint.mock.calls.map(call=>call[0]);
 expect(a).toEqual({indexes:['db_conn:/api/v1/media/:id/bytes'],blobs:['porchday_metrics_v1','production','db_conn','/api/v1/media/:id/bytes','none','social_close','none'],doubles:[0,40,1,12]});
 expect(b.blobs[3]).toBe('none');
 expect(c.blobs.slice(2,6)).toEqual(['db_snapshot','job:cron','none','jobs_idle_in_transaction']);
 expect(d.blobs[5]).toBe('none');
 // Ordinary request events keep their existing coarse route categories.
 expect(e.blobs[3]).toBe('none');
});

test('push-denial counters retain finite channel codes without identifiers or hosted console output',()=>{
 const writeDataPoint=vi.fn(),consoleOutput=vi.spyOn(console,'log').mockImplementation(()=>{});
 try{
  for(const code of ['web_push_denied','native_push_denied'])event('job',{code,count:1,sessionId:'private-session',jobId:'private-job',endpoint:'https://private.example/token',token:'private-token'} as never,{ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  expect(writeDataPoint.mock.calls.map(c=>c[0])).toEqual(['web_push_denied','native_push_denied'].map(code=>({indexes:['job:none'],blobs:['porchday_metrics_v1','staging','job','none','none',code,'none'],doubles:[0,-1,1]})));
  expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('private');expect(consoleOutput).not.toHaveBeenCalled();
 }finally{consoleOutput.mockRestore();}
});
