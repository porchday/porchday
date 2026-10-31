import {beforeEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import type {Env,Variables} from '../src/types';
const mocks=vi.hoisted(()=>({query:vi.fn(),end:vi.fn(),getSession:vi.fn()}));
vi.mock('../src/auth',()=>({
 authPool:()=>({query:mocks.query,end:mocks.end}),
 hashToken:async()=> 'synthetic-key',
 createAuth:()=>({api:{getSession:mocks.getSession}}),
}));
import {authRoutes} from '../src/auth-routes';
beforeEach(()=>{
 mocks.query.mockReset().mockResolvedValue({rows:[{count:1}]});
 mocks.end.mockReset().mockResolvedValue(undefined);
 mocks.getSession.mockReset().mockRejectedValue(Error('private auth failure'));
});
it.each(['rate_limit','initial_authorization'] as const)('retains %s failure timing without retrying or beginning mutation work',async(failedPhase)=>{
 if(failedPhase==='rate_limit')mocks.query.mockRejectedValue(Error('private SQL failure'));
 const writeDataPoint=vi.fn(),pending:Promise<unknown>[]=[];
 const env={ENVIRONMENT:'production',LOGOUT_PHASE_TIMING:'true',APP_URL:'https://example.test',BETTER_AUTH_SECRET:'synthetic',METRICS:{writeDataPoint}} as unknown as Env;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();app.route('/api/auth',authRoutes);
 const response=await app.fetch(new Request('https://example.test/api/auth/sign-out',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'{}'}),env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);
 await Promise.all(pending);
 expect(response.status).toBe(503);
 expect(mocks.query).toHaveBeenCalledTimes(1);
 expect(mocks.getSession).toHaveBeenCalledTimes(failedPhase==='rate_limit'?0:1);
 expect(mocks.end).toHaveBeenCalledTimes(1);
 const points=writeDataPoint.mock.calls.map(([point])=>point).filter(point=>point.blobs[2]==='journal_phase');
 expect(points.map(point=>point.blobs[5])).toEqual(failedPhase==='rate_limit'?['rate_limit']:['rate_limit','initial_authorization']);
 expect(JSON.stringify(points)).not.toMatch(/private|synthetic-key/);
 const summaries=writeDataPoint.mock.calls.map(([point])=>point).filter(point=>point.blobs[2]==='logout_summary');
 expect(summaries).toHaveLength(1);expect(summaries[0].doubles[1]).toBe(0);
 expect(summaries[0].doubles[2]).toBeGreaterThanOrEqual(0);
 if(failedPhase==='rate_limit')expect(summaries[0].doubles[3]).toBe(-1);else expect(summaries[0].doubles[3]).toBeGreaterThanOrEqual(0);
 expect(summaries[0].doubles.slice(4)).toEqual(Array(11).fill(-1));
 expect(JSON.stringify(summaries)).not.toMatch(/private|synthetic-key/);
});
