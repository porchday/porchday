import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import {QueueAdmissionLease,queueAdmissionHash,queueSnapshotHash,queueSnapshotPath,queueCreationExpectedSnapshot,type QueueAdmissionPlan} from './queue-admission-lease.ts';
import {FileUploadLease} from './release-upload-lease.ts';
const roots:string[]=[],leases:QueueAdmissionLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))try{lease.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-queue-create-')));chmodSync(root,0o700);roots.push(root);
 const operationId=randomUUID(),baselinePath=join(root,'baseline.json'),before={queues:{staging:{queue_id:'a'.repeat(32),queue_name:'porchday-staging-jobs'},production:{queue_id:'b'.repeat(32),queue_name:'porchday-production-jobs'}},workers:{staging:{version:'unchanged'},production:{version:'unchanged'}},domains:[],schedules:{}};
 const canonical=JSON.stringify({stagingVersion:'unchanged',productionVersion:'unchanged',latestProviderSnapshot:baselinePath})+'\n',target=JSON.stringify({...JSON.parse(canonical),latestProviderSnapshot:queueSnapshotPath(root,operationId)})+'\n';
 writeFileSync(baselinePath,JSON.stringify(before),{mode:0o600});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const expected=queueCreationExpectedSnapshot(before,'staging-denial-0'),snapshot=structuredClone(expected);snapshot.queues['staging-denial-0'].queue_id='c'.repeat(32);
 const plan:QueueAdmissionPlan={operationId,worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:queueAdmissionHash(canonical),targetCanonicalSha256:queueAdmissionHash(target),expectedSnapshotSha256:queueSnapshotHash(expected),requestSha256:queueAdmissionHash('synthetic fixed create body'),creation:{key:'staging-denial-0',baselineSnapshotSha256:queueSnapshotHash(before)}};
 const acquire=()=>{const lease=QueueAdmissionLease.acquire(root,plan);leases.push(lease);return lease;};
 return{root,plan,canonical,target,baselinePath,before,snapshot,acquire,signal:AbortSignal.timeout(10000)};
}
describe('queue creation with provider-assigned identity',()=>{
 it('retains an omitted optional pause field verbatim through interrupted finalization',async()=>{
  const f=fixture(),actual=structuredClone(f.snapshot);delete (actual.queues['staging-denial-0'].settings as {delivery_paused?:boolean}).delivery_paused;
  let lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:actual,evidenceDigest:'d'.repeat(64)}),f.signal);lease.close();lease=f.acquire();
  await lease.finalize(f.target,async()=>actual,f.signal);lease.release();const proof=JSON.parse(readFileSync(queueSnapshotPath(f.root,f.plan.operationId),'utf8'));
  expect(proof).toEqual(actual);expect(proof.queues['staging-denial-0'].settings).not.toHaveProperty('delivery_paused');
 });
 it.each([true,null,'false'])('rejects an explicit unsupported pause value %s',async value=>{
  const f=fixture(),actual=structuredClone(f.snapshot),lease=f.acquire();(actual.queues['staging-denial-0'].settings as any).delivery_paused=value;
  await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await expect(lease.reconcile(async()=>({snapshot:actual,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow('PROVIDER_CHANGED');
 });
 it('reconciles a lost reply without another send and finalizes the actual ID',async()=>{
  const f=fixture(),send=vi.fn(async()=>{throw Error('lost reply');});let lease=f.acquire();
  expect(JSON.parse(readFileSync(join(f.root,'deployment-lock/owner.json'),'utf8')).protocol).toBe('porchday-queue-creation-v1');
  expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');lease.close();lease=f.acquire();
  expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);
  await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);
  await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.close();lease=f.acquire();
  expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();
  const stored=JSON.parse(readFileSync(queueSnapshotPath(f.root,f.plan.operationId),'utf8'));expect(stored.queues['staging-denial-0'].queue_id).toBe('c'.repeat(32));expect(JSON.stringify(stored)).not.toContain('provider-assigned');expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.target);expect(send).toHaveBeenCalledTimes(1);expect(()=>f.acquire()).toThrow('ALREADY_TERMINAL');
 });
 it.each(['consumer','producer','pause setting','settings','other worker','extra queue','duplicate id'])('refuses %s drift while retaining the original operation',async kind=>{
  const f=fixture(),lease=f.acquire(),send=vi.fn(async()=>{});await lease.dispatchOnce(async()=>{},send,f.signal);
  const bad=structuredClone(f.snapshot) as any,q=bad.queues['staging-denial-0'];
  if(kind==='consumer'){q.consumers=[{}];q.consumers_total_count=1;}
  if(kind==='producer'){q.producers=[{}];q.producers_total_count=1;}
  if(kind==='pause setting')q.settings.delivery_paused=true;
  if(kind==='settings')q.settings.delivery_delay=1;
  if(kind==='other worker')bad.workers.production.version='changed';
  if(kind==='extra queue')bad.queues.other={...q,queue_id:'e'.repeat(32)};
  if(kind==='duplicate id')q.queue_id='a'.repeat(32);
  await expect(lease.reconcile(async()=>({snapshot:bad,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow();
  expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
 });
 it('does not infer a failed create from an empty read and cannot cancel after intent',async()=>{
  const f=fixture(),lease=f.acquire(),send=vi.fn(async()=>{throw Error('unknown');});await lease.dispatchOnce(async()=>{},send,f.signal);
  await expect(lease.reconcile(async()=>({snapshot:f.before,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow();expect(()=>lease.cancelBeforeDispatch()).toThrow('CANCELLATION_UNSAFE');
  expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);
 });
 it('pins the observed ID across reconcile and finalization',async()=>{
  const f=fixture(),lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);
  const replaced=structuredClone(f.snapshot);replaced.queues['staging-denial-0'].queue_id='e'.repeat(32);
  await expect(lease.reconcile(async()=>({snapshot:replaced,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow('PROOF_CHANGED');await expect(lease.finalize(f.target,async()=>replaced,f.signal)).rejects.toThrow('PROVIDER_CHANGED');
 });
 it('resumes a durable finalization receipt before canonical replacement',async()=>{
  const f=fixture();let lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);
  writeFileSync(join(f.root,'deployment-lock/queue-finalization.json'),JSON.stringify({v:1,planHash:queueSnapshotHash(f.plan),beforeCanonical:f.canonical,canonical:f.target}),{mode:0o600});lease.close();lease=f.acquire();const send=vi.fn();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();expect(send).not.toHaveBeenCalled();expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.target);
 });
 it('checks the immutable baseline before dispatch and excludes concurrent upload leases',async()=>{
  const f=fixture(),lease=f.acquire();expect(()=>FileUploadLease.acquire(f.root,{operationId:randomUUID(),worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:f.plan.canonicalSha256,evidenceDigest:'e'.repeat(64)})).toThrow();
  writeFileSync(f.baselinePath,JSON.stringify({...f.before,domains:['drift']}));const send=vi.fn();await expect(lease.dispatchOnce(async()=>{},send,f.signal)).rejects.toThrow('BASELINE_CHANGED');expect(send).not.toHaveBeenCalled();lease.cancelBeforeDispatch();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 });
 it('rejects a pre-existing name, wrong environment, or forged planned settings',()=>{
  const f=fixture();expect(()=>queueCreationExpectedSnapshot(f.snapshot,'staging-denial-0')).toThrow('ALREADY_EXISTS');
  f.plan.creation!.key='production-denial-0';expect(()=>f.acquire()).toThrow('CREATION_PLAN_INVALID');f.plan.creation!.key='staging-denial-0';f.plan.expectedSnapshotSha256='e'.repeat(64);expect(()=>f.acquire()).toThrow('CREATION_PLAN_INVALID');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 });
});
