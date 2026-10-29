import {beforeEach,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({valid:true,fail:false,queries:[] as string[],values:[] as unknown[][],mode:'',end:vi.fn(async()=>{})}));
vi.mock('postgres',()=>({default:vi.fn(()=>({end:db.end,begin:async(mode:string,run:(tx:unknown)=>unknown)=>{db.mode=mode;return run(async(parts:TemplateStringsArray,...values:unknown[])=>{db.queries.push(parts.join('?'));db.values.push(values);if(db.fail)throw Error('private database detail');return parts[0].startsWith('select')?[{valid:db.valid}]:[];});}}))}));
import {verifyReleaseProbeFixture,withReleaseProbePreflight} from './release-probe-preflight';
import {recoverDeployment,type DeploymentPorts,type RecoveryState,type DeploymentPlan} from './deployment-recovery';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const config={environment:'production' as const,healthToken:'a'.repeat(40),synthetic:{id:uuid(1),email:uuid(1)+'@example.test',password:'s'.repeat(40)}};
const options={connection:'postgres://role.branch@host.pg.psdb.cloud:5432/db',branchId:'branch',config,signal:new AbortController().signal};
const plan:DeploymentPlan={operationId:uuid(2),worker:'porchday-production',candidateVersion:uuid(3),baselineVersion:uuid(4),baselineDeploymentId:uuid(5),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(4)],evidenceDigest:'b'.repeat(64)};
beforeEach(()=>{db.valid=true;db.fail=false;db.queries=[];db.values=[];db.end.mockClear();});
it('checks identity and credential existence with a bounded read-only transaction and no secret output',async()=>{
 await expect(verifyReleaseProbeFixture(options)).resolves.toBeUndefined();
 expect(db.mode).toBe('isolation level repeatable read read only');expect(db.queries).toHaveLength(4);
 expect(db.queries[3]).toContain('select exists');expect(db.values[3]).toEqual([config.synthetic.id,config.synthetic.email]);
 expect(db.queries.join('')).not.toContain(config.synthetic.email);expect(JSON.stringify(db.values)).not.toContain(config.synthetic.password);expect(db.end).toHaveBeenCalledTimes(1);
});
it('rejects missing or mismatched account and hides database errors',async()=>{
 db.valid=false;await expect(verifyReleaseProbeFixture(options)).rejects.toThrow('RELEASE_PROBE_FIXTURE_INVALID');
 db.fail=true;await expect(verifyReleaseProbeFixture(options)).rejects.toThrow('RELEASE_PROBE_PREFLIGHT_READ_FAILED');expect(db.end).toHaveBeenCalledTimes(2);
});
it('does no database work for a wrong branch or already aborted request',async()=>{
 await expect(verifyReleaseProbeFixture({...options,branchId:'other'})).rejects.toThrow('RELEASE_SCHEMA_TARGET_INVALID');
 await expect(verifyReleaseProbeFixture({...options,signal:AbortSignal.abort()})).rejects.toThrow();expect(db.queries).toEqual([]);
});
it('a missing fixture stops the controller before activation intent or any provider write',async()=>{
 db.valid=false;let state:RecoveryState|null=null;
 const ports:DeploymentPorts={authorize:vi.fn(async()=>{}),observe:vi.fn(),deploy:vi.fn(),verify:vi.fn()};
 await expect(recoverDeployment(plan,{read:async()=>state,write:async(_old,next)=>{state=next;}},withReleaseProbePreflight(ports,s=>verifyReleaseProbeFixture({...options,signal:s})))).rejects.toThrow('RELEASE_PROBE_FIXTURE_INVALID');
 expect(state).toMatchObject({phase:'prepared'});expect(ports.deploy).not.toHaveBeenCalled();expect(ports.observe).not.toHaveBeenCalled();expect(ports.verify).not.toHaveBeenCalled();
});
it('preserves authorization order and allows rollback even when fixture validation would fail',async()=>{
 const order:string[]=[],ports:DeploymentPorts={authorize:vi.fn(async()=>{order.push('authorize');}),observe:vi.fn(),deploy:vi.fn(),verify:vi.fn()},check=vi.fn(async()=>{order.push('fixture');});
 const wrapped=withReleaseProbePreflight(ports,check);
 await wrapped.authorize(plan,'activate',options.signal);expect(order).toEqual(['authorize','fixture']);
 check.mockRejectedValue(Error('unavailable'));await expect(wrapped.authorize(plan,'rollback',options.signal)).resolves.toBeUndefined();expect(check).toHaveBeenCalledTimes(1);
 ports.authorize=vi.fn(async()=>{throw Error('authorization failed');});await expect(withReleaseProbePreflight(ports,check).authorize(plan,'activate',options.signal)).rejects.toThrow('authorization failed');expect(check).toHaveBeenCalledTimes(1);
});
it('does not rerun preflight or activation when reconciling a dispatched candidate',async()=>{
 let state:RecoveryState={v:1,revision:2,planHash:(await import('./deployment-recovery')).deploymentPlanHash(plan),phase:'activation-intent'};
 const ports:DeploymentPorts={authorize:vi.fn(),observe:vi.fn(async()=>({version:plan.candidateVersion,deploymentId:uuid(6),operationId:plan.operationId})),deploy:vi.fn(),verify:vi.fn(async()=> 'healthy')},check=vi.fn(async()=>{throw Error('fixture unavailable');});
 expect(await recoverDeployment(plan,{read:async()=>state,write:async(_old,next)=>{state=next;}},withReleaseProbePreflight(ports,check))).toBe('complete');expect(check).not.toHaveBeenCalled();expect(ports.deploy).not.toHaveBeenCalled();
});
