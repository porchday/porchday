import {describe,it,expect,vi} from 'vitest';
import {OperationTrace,causalSpan,parseTraceparent,safeRoute,causalError,type CausalRecord,d1CausalSink} from '../src/causal-tracing';
import {causalPostgres,causalPgQuery} from '../src/causal-database';
import {tracedBindings} from '../src/causal-bindings';
import type {Env} from '../src/types';
function harness(sampled=true){const records:CausalRecord[]=[],tasks:Promise<unknown>[]=[];const trace=new OperationTrace('staging','release',undefined,async r=>{records.push(r);},p=>{tasks.push(p);},sampled);return {trace,records,async flush(){for(let i=0;i<tasks.length;i++)await tasks[i];}};}
describe('causal telemetry',()=>{
 it('retains parentage across overlapping async work without leaking between requests',async()=>{
  const a=harness(),b=harness();
  await Promise.all([a.trace.run(()=>causalSpan('db.transaction',async()=>{await Promise.resolve();await causalSpan('db.social.query',async()=>1);})),b.trace.run(()=>causalSpan('r2.get',async()=>2))]);
  a.trace.finish(200,'/api/v1/photos/:id');b.trace.finish(200);await a.flush();await b.flush();
  const spans=a.records.at(-1)!.spans;expect(spans[1].parent).toBe(spans[0].id);expect(b.records.at(-1)!.spans).toHaveLength(1);expect(a.trace.traceId).not.toBe(b.trace.traceId);
 });
 it('retains pending state and late completion independently of response outcome',async()=>{
  const h=harness();let resolve!:(n:number)=>void;
  const operation=h.trace.run(()=>causalSpan('r2.put',()=>new Promise<number>(r=>{resolve=r;})));
  h.trace.finish(503);await h.flush();expect(h.records[0].spans[0].outcome).toBe('pending');
  resolve(42);expect(await operation).toBe(42);await h.flush();expect(h.records.at(-1)!.spans[0].outcome).toBe('ok');expect(h.records.at(-1)!.status).toBe(503);
 });
 it('retains unsampled failures without copying messages or application data',async()=>{
  const h=harness(false),error=Object.assign(Error('secret member@example.com SQL password'),{code:'53300'});
  await expect(h.trace.run(()=>causalSpan('db.auth.query',()=>Promise.reject(error)))).rejects.toBe(error);
  h.trace.finish(503,'/api/v1/photos/12345678-1234-1234-1234-123456789012');await h.flush();expect(h.records[0].reason).toBe('error');expect(h.records[0].spans[0].code).toBe('53300');expect(JSON.stringify(h.records)).not.toContain('password');expect(h.records[0].route).toBe('/api/*');
 });
 it('bounds spans, records loss, rejects invalid correlation and raw route IDs',async()=>{
  const h=harness();await h.trace.run(async()=>{for(let i=0;i<170;i++)await causalSpan('r2.get',async()=>1);});h.trace.finish(200);await h.flush();expect(h.records[0].spans).toHaveLength(160);expect(h.records[0].droppedSpans).toBe(10);
  expect(parseTraceparent('00-'+'0'.repeat(32)+'-'+'1'.repeat(16)+'-01')).toBeUndefined();expect(safeRoute('/api/v1/photos/12345')).toBe('/api/*');expect(causalError(Error('secret'))).toBe('OPERATION_FAILED');
 });
 it('export failures never change operation success',async()=>{
  const tasks:Promise<unknown>[]=[];const trace=new OperationTrace('staging','release',undefined,async()=>{throw Error('down');},t=>{tasks.push(t);},true);
  expect(await trace.run(()=>causalSpan('r2.get',async()=>7))).toBe(7);trace.finish(200);await Promise.all(tasks);
 });
 it('preserves lazy postgres query modifiers and executes only once',async()=>{
  let executes=0;const raw=()=>{let p:Promise<unknown>|undefined;const q={then(a:any,b:any){return(p??=Promise.resolve().then(()=>{executes++;return [9];})).then(a,b);},values(){return q;}};return q;};
  const h=harness();await h.trace.run(async()=>{const sql=causalPostgres(raw,'social');const q=sql().values();expect(executes).toBe(0);expect(await q).toEqual([9]);expect(await q).toEqual([9]);});h.trace.finish(200);await h.flush();expect(executes).toBe(1);expect(h.records[0].spans).toHaveLength(1);
 });
 it('pg callback APIs retain return value and original callback',()=>{
  const callback=vi.fn(),query=vi.fn(()=>undefined),client={query};causalPgQuery(client,'auth');expect(client.query('select 1',callback)).toBeUndefined();expect(query).toHaveBeenCalledWith('select 1',callback);
 });
 it('propagates queue identity without copying message content into spans',async()=>{
  const h=harness();let received:any;const env=tracedBindings({OPERATIONAL_TRACING:'true',JOBS:{send:async(body:any)=>{received=body;}}} as Env);
  await h.trace.run(()=>env.JOBS.send({kind:'expiry'}));h.trace.finish(200);await h.flush();const context=parseTraceparent(received.traceparent)!;expect(context.traceId).toBe(h.trace.traceId);expect(context.spanId).toBe(h.records[0].spans[0].id);expect(received.kind).toBe('expiry');
 });
 it('binds R2 native receivers and includes response-body work',async()=>{
  const h=harness(),body={text:async()=> 'private'},bucket={get:async function(){expect(this).toBe(bucket);return body;}};
  const env=tracedBindings({OPERATIONAL_TRACING:'true',MEDIA:bucket} as unknown as Env);
  await h.trace.run(async()=>{expect(await(await env.MEDIA.get('private/key'))!.text()).toBe('private');});h.trace.finish(200);await h.flush();expect(h.records[0].spans.map(s=>s.name)).toEqual(['r2.get','r2.body']);expect(JSON.stringify(h.records)).not.toContain('private');
 });
 it('preserves native streaming identity, laziness and cancellation',async()=>{
  const h=harness();let pulls=0,cancelled:unknown;
  const body=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array([4,5]));},cancel(reason){cancelled=reason;}},{highWaterMark:0});
  const env=tracedBindings({OPERATIONAL_TRACING:'true',MEDIA:{get:async()=>({body,size:2})}} as unknown as Env);
  await h.trace.run(async()=>{const object=await env.MEDIA.get('private/key');expect(object!.body).toBe(body);expect(object!.body).toBe(body);await Promise.resolve();expect(pulls).toBe(0);await object!.body.cancel('private reason');});
  h.trace.finish(200);await h.flush();expect(cancelled).toBe('private reason');expect(h.records.at(-1)!.spans.map(s=>s.name)).toEqual(['r2.get','r2.stream.handoff']);expect(h.records.at(-1)!.spans[1].quantity).toBe(2);expect(JSON.stringify(h.records)).not.toContain('private');
 });
 it('records exporter loss independently of the failed trace store',async()=>{
  const signal=vi.fn();const sink=d1CausalSink({ENVIRONMENT:'staging',METRICS:{writeDataPoint:signal},TRACES:{prepare(){throw Error('storage down');}}} as unknown as Env);
  const h=harness();h.trace.finish(500);await h.flush();await sink(h.records[0]);expect(signal.mock.calls.at(-1)?.[0].blobs).toContain('export_failed');
 });
});

describe.skipIf(!process.env.CAUSAL_DATABASE_URL)('real database driver contracts',()=>{
 it('postgres tagged templates, transaction rollback and values retain behavior',async()=>{
  const {default:postgres}=await import('postgres');const h=harness();
  await h.trace.run(async()=>{
   const sql=causalPostgres(postgres(process.env.CAUSAL_DATABASE_URL!,{max:1}),'social');
   try{
    expect((await sql`select ${7}::int as value`)[0].value).toBe(7);
    expect(await sql`select ${8}::int as value`.values()).toEqual([[8]]);
    expect((await sql.begin(async db=>db`select ${9}::int as value`))[0].value).toBe(9);
    await expect(sql.begin(async db=>{await db`select 1`;throw Error('rollback');})).rejects.toThrow('rollback');
    expect((await sql`select 10::int as value`)[0].value).toBe(10);
   }finally{await sql.end();}
  });h.trace.finish(200);await h.flush();expect(h.records.at(-1)!.spans.filter(s=>s.name==='db.transaction')).toHaveLength(2);
 });
 it('pg queries preserve results, database errors, transaction state and callbacks',async()=>{
  const {Pool}=await import('pg');const h=harness(),pool=new Pool({connectionString:process.env.CAUSAL_DATABASE_URL});
  pool.on('connect',client=>causalPgQuery(client,'auth'));
  try{await h.trace.run(async()=>{
   expect((await pool.query('select $1::int as value',[12])).rows[0].value).toBe(12);
   await expect(pool.query('select 1/0')).rejects.toMatchObject({code:'22012'});
   await new Promise<void>((resolve,reject)=>{pool.query('select 13 as value',(error,result)=>{if(error)reject(error);else{expect(result.rows[0].value).toBe(13);resolve();}});});
  });}finally{await pool.end();}h.trace.finish(200);await h.flush();expect(h.records.at(-1)!.reason).toBe('error');
 });
});
