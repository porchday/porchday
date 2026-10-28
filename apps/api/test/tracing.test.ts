import {expect,test} from 'vitest';
import {Hono} from 'hono';
import {tracingMiddleware,traceError,traceSpan,countTrace,recordTraceSpan,traceIdFrom,describeError,scrubMessage} from '../src/tracing';
import {requestTimingMiddleware,phaseTiming} from '../src/request-timing';
import {measureFeedPhase,traceTiming} from '../src/feed-timing';
import type {Env,Variables} from '../src/types';

const traceId='4bf92f3577b34da6a3ce929d0e0e4736';
const traceparent='00-'+traceId+'-00f067aa0ba902b7-01';
const member='4dc907ef-5906-47da-9214-84bbd9f5fb22';

function router(signedIn=true){
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',tracingMiddleware());
 app.use('*',requestTimingMiddleware);
 app.use('*',async(c,next)=>{if(signedIn)c.set('memberId',member);await next();});
 app.get('/api/v1/media/:id/bytes',async c=>{
  await measureFeedPhase(phaseTiming(c),'journal_check',async()=>{});
  await measureFeedPhase(traceTiming(),'social_query',async()=>{});
  await traceSpan('r2_media_get',async()=>{});
  countTrace('db_conn_social');countTrace('db_conn_social');
  return c.text('ok');
 });
 app.get('/fail',()=>{throw Object.assign(Error('duplicate key (email)=(member@example.test) token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),{code:'23505'});});
 app.onError((error,c)=>{traceError(error);return c.json({error:{code:'SERVICE_UNAVAILABLE'}},503);});
 return app;
}
const env={ENVIRONMENT:'production',CF_VERSION_METADATA:{id:'44afbb8d-3133-4aac-8663-efd6fb5feb47'}} as unknown as Env;

test('a traced member request returns its own spans, counts and route pattern in Server-Timing',async()=>{
 const response=await router().request('https://porchday.org/api/v1/media/'+member+'/bytes',{headers:{traceparent}},env);
 const header=response.headers.get('server-timing')!;
 expect(header).toContain('pd-trace;desc="'+traceId+'"');
 expect(header).toMatch(/pd-total;dur=[0-9.]+/);
 expect(header).toContain('pd-release;desc="44afbb8d"');
 expect(header).toContain('pd-route;desc="/api/v1/media/:id/bytes"');
 for(const name of ['journal_check','social_query','r2_media_get'])expect(header).toMatch(new RegExp('pd-span;dur=[0-9.]+;desc="'+name+'@[0-9.]+"'));
 expect(header).toContain('pd-count;desc="db_conn_social=2"');
 // A phase measured through RequestTiming is recorded once, not twice.
 expect(header.match(/journal_check@/g)).toHaveLength(1);
});

test('untraced, anonymous and malformed requests receive no trace detail',async()=>{
 const path='https://porchday.org/api/v1/media/'+member+'/bytes';
 expect((await router().request(path,{},env)).headers.has('server-timing')).toBe(false);
 expect((await router(false).request(path,{headers:{traceparent}},env)).headers.has('server-timing')).toBe(false);
 for(const header of ['00-'+'0'.repeat(32)+'-00f067aa0ba902b7-01','01-'+traceId+'-00f067aa0ba902b7-01','00-'+traceId.toUpperCase()+'-00f067aa0ba902b7-01','garbage'])
  expect(traceIdFrom(header)).toBeUndefined();
 expect(traceIdFrom(traceparent)).toBe(traceId);
 // Outside a traced request these are no-ops.
 expect(()=>{recordTraceSpan('x',1);countTrace('x');}).not.toThrow();
 expect(traceTiming()).toBeUndefined();
});

test('a traced failure explains itself without emails, tokens or stack traces',async()=>{
 const response=await router().request('https://porchday.org/fail',{headers:{traceparent}},env);
 expect(response.status).toBe(503);
 const header=response.headers.get('server-timing')!;
 expect(header).toContain('pd-error;desc="class=Error sqlstate=23505 msg=duplicate key (email)=([email]) token [token]"');
 expect(header).not.toMatch(/example\.test|AAAAAAAA|at \//);
});

test('error descriptions keep codes and bounded scrubbed messages only',()=>{
 expect(describeError(Object.assign(Error('x'),{code:'RECENT_AUTH_REQUIRED'}))).toBe('class=Error code=RECENT_AUTH_REQUIRED msg=x');
 expect(describeError({name:'<script>',code:'lowercase'})).toBe('class=Error');
 expect(describeError(undefined)).toBe('class=Error');
 expect(scrubMessage('a'.repeat(500))).toBe('[token]');
 expect(scrubMessage('word '.repeat(100)).length).toBeLessThanOrEqual(200);
});

test('concurrent traced requests keep separate spans',async()=>{
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',tracingMiddleware());
 app.use('*',async(c,next)=>{c.set('memberId',member);await next();});
 app.get('/:name',async c=>{
  await traceSpan('span_'+c.req.param('name'),()=>new Promise(resolve=>setTimeout(resolve,c.req.param('name')==='a'?20:1)));
  return c.text('ok');
 });
 const [a,b]=await Promise.all(['a','b'].map(name=>app.request('https://porchday.org/'+name,{headers:{traceparent}},env)));
 expect(a.headers.get('server-timing')).toContain('span_a@');expect(a.headers.get('server-timing')).not.toContain('span_b@');
 expect(b.headers.get('server-timing')).toContain('span_b@');expect(b.headers.get('server-timing')).not.toContain('span_a@');
});
