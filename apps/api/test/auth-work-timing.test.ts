import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import type {Env,Variables} from '../src/types';
const f=vi.hoisted(()=>({clock:0,fail:'',calls:[] as string[],release:vi.fn(),end:vi.fn(),authReads:0}));
async function step(name:string){f.calls.push(name);f.clock+=7;if(f.fail===name)throw Error('private failure '+name);}
vi.mock('../src/auth',()=>({
 hashToken:async()=> 'synthetic-key',
 authPool:()=>({end:f.end,query:async(sql:string)=>{await step(sql.includes('auth_rate_limits')?'rate':'initial_status');return {rows:[{count:1,status:'active'}]};},connect:async()=>{await step('acquire');return {release:f.release,query:async(sql:string)=>{const name=sql==='BEGIN'?'begin':sql.startsWith('SET LOCAL')?'setup':sql.includes('pg_advisory')?'lock':sql==='COMMIT'?'commit':sql==='ROLLBACK'?'rollback':'status';await step(name);return {command:sql,rows:[{status:'active'}]};}};}}),
 createAuth:()=>({api:{getSession:async()=>{await step(++f.authReads===1?'initial_auth':'reauthorize');return {user:{id:'11111111-1111-4111-8111-111111111111'},session:{id:'22222222-2222-4222-8222-222222222222',createdAt:new Date()}};}},handler:async()=>{await step('handler');return Response.json({success:true});}}),
}));
// This suite isolates transaction timing. Real journal rollback/commit ambiguity
// and revocation semantics remain covered by the PostgreSQL integration suite.
vi.mock('../src/privacy-journal',()=>({JournalError:class extends Error{},withHttpAuthPrivacyJournal:async(_c:unknown,work:()=>Promise<unknown>)=>work()}));
import {authRoutes} from '../src/auth-routes';
beforeEach(()=>{f.clock=0;f.fail='';f.calls=[];f.authReads=0;f.release.mockReset();f.end.mockReset().mockResolvedValue(undefined);vi.spyOn(performance,'now').mockImplementation(()=>f.clock);});
afterEach(()=>vi.restoreAllMocks());
async function run(throwMetrics=false){
 const points:AnalyticsEngineDataPoint[]=[],pending:Promise<unknown>[]=[];
 const env={ENVIRONMENT:'production',LOGOUT_PHASE_TIMING:'true',APP_URL:'https://example.test',BETTER_AUTH_SECRET:'synthetic',METRICS:{writeDataPoint:(p:AnalyticsEngineDataPoint)=>{if(throwMetrics)throw Error('private telemetry error');points.push(p);}}} as unknown as Env;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();app.route('/api/auth',authRoutes);
 const response=await app.fetch(new Request('https://example.test/api/auth/sign-out',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'{}'}),env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);await Promise.all(pending);
 return {response,points,phases:points.filter(p=>p.blobs?.[2]==='journal_phase').map(p=>({phase:p.blobs![5],ms:p.doubles![1]}))};
}
it('separates acquisition, transaction setup, lock, reauthorization, handler and commit without reordering',async()=>{
 const {response,points,phases}=await run();expect(response.status).toBe(200);
 expect(f.calls).toEqual(['rate','initial_auth','initial_status','acquire','begin','setup','lock','reauthorize','status','handler','commit']);
 expect(phases.filter(p=>String(p.phase).startsWith('work_'))).toEqual([
  {phase:'work_pool_acquire',ms:7},{phase:'work_begin',ms:14},{phase:'work_identity_lock',ms:7},{phase:'work_reauthorization',ms:14},{phase:'work_handler',ms:7},{phase:'work_commit',ms:7},
 ]);
 const summary=points.filter(p=>p.blobs?.[2]==='logout_summary');expect(summary).toHaveLength(1);expect(summary[0].blobs?.[0]).toBe('porchday_logout_summary_v1');expect(summary[0].doubles).toHaveLength(15);
 expect(f.release).toHaveBeenCalledTimes(1);expect(f.end).toHaveBeenCalledTimes(1);expect(JSON.stringify(points)).not.toMatch(/private|11111111|22222222|SELECT|synthetic-key/);
});
it.each([['acquire','work_pool_acquire'],['begin','work_begin'],['setup','work_begin'],['lock','work_identity_lock'],['reauthorize','work_reauthorization'],['handler','work_handler'],['commit','work_commit']])('retains failed %s duration without replaying or skipping required rollback',async(failure,phase)=>{
 f.fail=failure;const {response,phases}=await run();expect(response.status).toBe(503);expect(f.calls.filter(x=>x===failure)).toHaveLength(1);expect(phases.some(p=>p.phase===phase&&Number(p.ms)>=7)).toBe(true);
 const rollbackExpected=!['acquire','begin'].includes(failure);expect(f.calls.filter(x=>x==='rollback')).toHaveLength(rollbackExpected?1:0);expect(phases.some(p=>p.phase==='work_rollback')).toBe(rollbackExpected);
 expect(f.release).toHaveBeenCalledTimes(failure==='acquire'?0:1);expect(f.end).toHaveBeenCalledTimes(1);
});
it('telemetry failure does not alter commit, response or operation count',async()=>{
 const {response}=await run(true);expect(response.status).toBe(200);expect(f.calls.filter(x=>x==='commit')).toHaveLength(1);expect(f.calls).not.toContain('rollback');expect(f.release).toHaveBeenCalledTimes(1);
});
