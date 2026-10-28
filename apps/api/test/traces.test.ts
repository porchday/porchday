import {expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {createTraceRoutes,storeTrace,cleanupTraces,deleteMemberTraces,WriteLimiter,TRACE_RETENTION_MS,MAX_SPANS_PER_UPLOAD,type TraceUpload} from '../src/traces';
import {sqliteD1} from './support/sqlite-d1';
import type {Env,Variables} from '../src/types';

const a='4dc907ef-5906-47da-9214-84bbd9f5fb22',b='9a2f6c1e-1111-4222-8333-444455556666';
const traceId='4bf92f3577b34da6a3ce929d0e0e4736';
function upload(spans=3,id=traceId):TraceUpload {
 return {trace_id:id,started_at:1_793_000_000_000,page:'/app',browser:'Chrome 141',connection:'4g',
  spans:Array.from({length:spans},(_,seq)=>({seq,kind:'resource' as const,name:'GET /api/v1/feed',start:seq*10,dur:5,attrs:{status:200}}))};
}
function setup(){
 const d1=sqliteD1(),writeDataPoint=vi.fn();
 const env={ENVIRONMENT:'production',TRACES:d1.db,METRICS:{writeDataPoint},CF_VERSION_METADATA:{id:'release-1'}} as unknown as Env;
 let member=a;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',async(c,next)=>{c.set('memberId',member);await next();});
 app.route('/api/v1',createTraceRoutes());
 const points=()=>writeDataPoint.mock.calls.map(call=>call[0]);
 return {d1,env,app,points,as:(id:string)=>{member=id;}};
}
const post=(body:unknown)=>({method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});

test('an upload is one D1 batch, and repeated batches extend the same trace without duplicates',async()=>{
 const {d1,env,app,points}=setup();
 expect((await app.request('/api/v1/traces',post(upload(3)),env)).status).toBe(202);
 expect(d1.calls.batches).toBe(1);
 // A retried or overlapping batch is idempotent per sequence number.
 const next=upload(5);
 expect((await app.request('/api/v1/traces',post(next),env)).status).toBe(202);
 expect(d1.sqlite.prepare('select count(*) n from trace_spans').get()).toEqual({n:5});
 const trace=await (await app.request('/api/v1/traces/'+traceId,{},env)).json();
 expect(trace).toMatchObject({trace_id:traceId,page:'/app',release:'release-1',browser:'Chrome 141'});
 expect(trace.spans).toHaveLength(5);expect(trace.spans[0]).toMatchObject({seq:0,kind:'resource',name:'GET /api/v1/feed',duration_ms:5,attrs:{status:200}});
 const list=await (await app.request('/api/v1/traces',{},env)).json();
 expect(list.items.map((row:{trace_id:string})=>row.trace_id)).toEqual([traceId]);
 // Every D1 call reports its wall time, D1 duration and row count.
 const writes=points().filter(point=>point.blobs[5]==='trace_write_ok');
 expect(writes).toHaveLength(2);
 for(const point of writes){expect(point.blobs.slice(2,4)).toEqual(['trace_store','/api/v1/traces']);expect(point.doubles).toHaveLength(4);expect(point.doubles[3]).toBeGreaterThanOrEqual(0);}
 expect(points().some(point=>point.blobs[5]==='trace_read_ok')).toBe(true);
});

test('members see and extend only their own traces',async()=>{
 const {d1,env,app,as}=setup();
 await app.request('/api/v1/traces',post(upload(2)),env);
 as(b);
 expect((await app.request('/api/v1/traces/'+traceId,{},env)).status).toBe(404);
 expect((await (await app.request('/api/v1/traces',{},env)).json()).items).toEqual([]);
 // Guessing another member's trace ID cannot append spans or take it over.
 await app.request('/api/v1/traces',post({...upload(4),spans:upload(4).spans.map(span=>({...span,seq:span.seq+100}))}),env);
 expect(d1.sqlite.prepare('select member_id,span_count from traces').all()).toEqual([{member_id:a,span_count:2}]);
 expect(d1.sqlite.prepare('select count(*) n from trace_spans').get()).toEqual({n:2});
 await app.request('/api/v1/traces',{method:'DELETE'},env);
 expect(d1.sqlite.prepare('select count(*) n from traces').get()).toEqual({n:1});
 as(a);
 await app.request('/api/v1/traces',{method:'DELETE'},env);
 expect(d1.sqlite.prepare('select count(*) n from traces').get()).toEqual({n:0});
 expect(d1.sqlite.prepare('select count(*) n from trace_spans').get()).toEqual({n:0});
});

test('invalid, oversized and unknown-field uploads are rejected before D1',async()=>{
 const {d1,env,app}=setup();
 for(const body of ['not json',{...upload(),trace_id:'xyz'},{...upload(),extra:'field'},upload(MAX_SPANS_PER_UPLOAD+1),
  {...upload(),spans:[{...upload().spans[0],kind:'other'}]},{...upload(),spans:[{...upload().spans[0],dur:-1}]},
  {...upload(),spans:[{...upload().spans[0],attrs:{'Bad Key':1}}]}])
  expect((await app.request('/api/v1/traces',post(body),env)).status).toBe(400);
 expect((await app.request('/api/v1/traces',post('x'.repeat(300*1024)),env)).status).toBe(413);
 expect(d1.calls.batches).toBe(0);
 expect((await app.request('/api/v1/traces/not-hex',{},env)).status).toBe(404);
});

test('browser error text is scrubbed and control characters are removed',async()=>{
 const {d1,env,app}=setup();
 const body=upload(1);body.spans[0]={...body.spans[0],kind:'error',name:'unhandled\u0000rejection',attrs:{error:'failed for member@example.test with token '+'Z'.repeat(40)}};
 await app.request('/api/v1/traces',post(body),env);
 const row=d1.sqlite.prepare('select name,attrs from trace_spans').get() as {name:string;attrs:string};
 expect(row.name).toBe('unhandled rejection');
 expect(JSON.parse(row.attrs)).toEqual({error:'failed for [email] with token [token]'});
});

test('a per-isolate limiter caps concurrent and per-second D1 writes and reports drops',async()=>{
 let now=0;const limiter=new WriteLimiter(2,3,2,()=>now);
 expect([limiter.acquire(),limiter.acquire(),limiter.acquire()]).toEqual([true,true,false]); // concurrency 2
 limiter.release();limiter.release();
 expect(limiter.acquire()).toBe(true);limiter.release();
 expect(limiter.acquire()).toBe(false); // burst of 3 spent
 now=500;expect(limiter.acquire()).toBe(true);limiter.release(); // 2/s refill
 const {d1,env,points}=setup();
 const closed=new WriteLimiter(1,1,1,()=>0);closed.acquire();
 expect(await storeTrace(env,a,upload(),{},Date.now(),closed)).toBe('throttled');
 expect(d1.calls.batches).toBe(0);
 expect(points().at(-1).blobs[5]).toBe('trace_write_throttled');
});

test('D1 failures are reported and never thrown into the request',async()=>{
 const {env,points}=setup();
 const failing={...env,TRACES:{prepare:()=>({bind:()=>({})}),batch:async()=>{throw Error('D1_ERROR: too many requests');}}} as unknown as Env;
 expect(await storeTrace(failing,a,upload(),{})).toBe('failed');
 expect(points().at(-1).blobs[5]).toBe('trace_write_failed');
});

test('retention removes traces 14 days after their last upload, and account deletion removes all of them',async()=>{
 const {d1,env}=setup();
 const now=Date.now();
 await storeTrace(env,a,upload(2,'1'.repeat(32)),{},now-TRACE_RETENTION_MS-1000);
 await storeTrace(env,a,upload(2,'2'.repeat(32)),{},now-1000);
 await storeTrace(env,b,upload(2,'3'.repeat(32)),{},now-1000);
 expect(await cleanupTraces(env,now)).toBe(1);
 expect(d1.sqlite.prepare('select trace_id from traces order by trace_id').all().map((row:any)=>row.trace_id)).toEqual(['2'.repeat(32),'3'.repeat(32)]);
 expect(d1.sqlite.prepare("select count(*) n from trace_spans where trace_id=?").get('1'.repeat(32))).toEqual({n:0});
 await deleteMemberTraces(env,a);
 expect(d1.sqlite.prepare('select member_id from traces').all()).toEqual([{member_id:b}]);
});

test('tracing endpoints report unavailable until D1 is provisioned',async()=>{
 const {app,env}=setup();
 const unprovisioned={...env,TRACES:undefined} as Env;
 for(const [method,path] of [['GET','/api/v1/traces'],['POST','/api/v1/traces'],['GET','/api/v1/traces/'+traceId],['DELETE','/api/v1/traces']]){
  const response=await app.request(path,{method,...(method==='POST'?{body:JSON.stringify(upload())}:{})},unprovisioned);
  expect(response.status).toBe(404);expect((await response.json()).error.code).toBe('TRACING_UNAVAILABLE');
 }
 expect(await cleanupTraces(unprovisioned)).toBe(0);
});
