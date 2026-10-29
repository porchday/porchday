import {expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {httpJournalTiming,measureJournalPhase} from '../src/journal-timing';
import {tracingMiddleware} from '../src/tracing';
import type {Env,Variables} from '../src/types';
const parent='00-11111111111111111111111111111111-2222222222222222-01';
function app(){
 const a=new Hono<{Bindings:Env;Variables:Variables}>();
 a.use('*',tracingMiddleware());
 a.put('/edit',async c=>{
  if(c.req.header('x-synthetic-member')==='yes')c.set('memberId','synthetic');
  const timing=httpJournalTiming(c.env,{method:'PUT',path:'/api/v1/posts/private-id'});
  timing?.record('work',12);timing?.record('receipt',7);
  timing?.record('private-member-token' as never,1);timing?.record('work',NaN);timing?.record('work',-1);
  return c.json({ok:true,timed:!!timing});
 });return a;
}
it('traces opted-in edit phases without widening aggregate export or retaining identifiers',async()=>{
 const writeDataPoint=vi.fn(),env={ENVIRONMENT:'staging',METRICS:{writeDataPoint}} as unknown as Env;
 const response=await app().request('https://example.test/edit',{method:'PUT',headers:{traceparent:parent,'x-synthetic-member':'yes'}},env);
 const header=response.headers.get('server-timing')!;
 expect(header).toContain('privacy_work@');expect(header).toContain('privacy_receipt@');
 expect(header).not.toMatch(/private-id|private-member-token|NaN/);expect(writeDataPoint).not.toHaveBeenCalled();
});
it('ordinary edits have no phase observer, and anonymous traces have no returned internal timings',async()=>{
 const env={ENVIRONMENT:'production'} as Env;
 const ordinary=await app().request('https://example.test/edit',{method:'PUT'},env);
 expect((await ordinary.json() as any).timed).toBe(false);expect(ordinary.headers.has('server-timing')).toBe(false);
 const anonymous=await app().request('https://example.test/edit',{method:'PUT',headers:{traceparent:parent}},env);
 expect(anonymous.headers.has('server-timing')).toBe(false);
});
it('logout aggregate timing remains available without tracing and preserves the work result',async()=>{
 const writeDataPoint=vi.fn(),env={ENVIRONMENT:'production',LOGOUT_PHASE_TIMING:'true',METRICS:{writeDataPoint}} as unknown as Env;
 const timing=httpJournalTiming(env,{method:'POST',path:'/api/auth/sign-out'});
 expect(timing).toBeDefined();const original=Error('private original'),work=vi.fn(async()=>{throw original;});
 await expect(measureJournalPhase(timing,'work',work)).rejects.toBe(original);
 expect(work).toHaveBeenCalledOnce();expect(writeDataPoint).toHaveBeenCalledOnce();
 expect(httpJournalTiming(env,{method:'PUT',path:'/api/v1/posts/private-id'})).toBeUndefined();
});
