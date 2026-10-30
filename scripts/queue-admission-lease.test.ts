import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import {QueueAdmissionLease,queueAdmissionHash,queueSnapshotHash,queueSnapshotPath,type QueueAdmissionPlan} from './queue-admission-lease.ts';
import {FileUploadLease} from './release-upload-lease.ts';
const roots:string[]=[],leases:QueueAdmissionLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))try{lease.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-queue-admission-')));chmodSync(root,0o700);roots.push(root);const operationId=randomUUID(),before={stagingVersion:'unchanged',productionVersion:'unchanged',latestProviderSnapshot:'/previous/snapshot.json'},canonical=JSON.stringify(before)+'\n',snapshot={queues:{staging:{max_concurrency:4}},workers:{staging:{version:'unchanged'},production:{version:'unchanged'}}},target=JSON.stringify({...before,latestProviderSnapshot:queueSnapshotPath(root,operationId)})+'\n';writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const plan:QueueAdmissionPlan={operationId,worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:queueAdmissionHash(canonical),expectedSnapshotSha256:queueSnapshotHash(snapshot),targetCanonicalSha256:queueAdmissionHash(target),requestSha256:queueAdmissionHash('{"max_concurrency":4}')};
 const acquire=()=>{const lease=QueueAdmissionLease.acquire(root,plan);leases.push(lease);return lease;};return{root,plan,canonical,target,snapshot,acquire,signal:AbortSignal.timeout(10000)};}
async function observed(f:ReturnType<typeof fixture>,lease:QueueAdmissionLease){await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'b'.repeat(64)}),f.signal);}
describe('queue admission durable shared lease',()=>{
 it('dispatches once, reconciles exact inventory, atomically advances canonical and archives',async()=>{
  const f=fixture(),lease=f.acquire(),send=vi.fn(async()=>{});expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('dispatched');expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);
  await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'b'.repeat(64)}),f.signal);expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
  await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.target);expect(()=>f.acquire()).toThrow('QUEUE_ADMISSION_ALREADY_TERMINAL');
 });
 it('preserves unknown send intent across process loss and never replays the request',async()=>{
  const f=fixture(),send=vi.fn(async()=>{throw Error('lost successful reply');});let lease=f.acquire();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(()=>lease.cancelBeforeDispatch()).toThrow();lease.close();lease=f.acquire();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'b'.repeat(64)}),f.signal);await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();
 });
 it('does not dispatch or retain an intent after failed authorization',async()=>{
  const f=fixture(),lease=f.acquire(),send=vi.fn();await expect(lease.dispatchOnce(async()=>{throw Error('baseline drift');},send,f.signal)).rejects.toThrow('baseline drift');expect(send).not.toHaveBeenCalled();lease.cancelBeforeDispatch();expect(()=>f.acquire()).toThrow('QUEUE_ADMISSION_ALREADY_TERMINAL');
 });
 it('holds both the kernel lock and persistent marker against ordinary upload work',async()=>{
  const f=fixture(),lease=f.acquire(),upload={operationId:randomUUID(),worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:f.plan.canonicalSha256,evidenceDigest:'c'.repeat(64)};
  expect(()=>FileUploadLease.acquire(f.root,upload)).toThrow('UPLOAD_LEASE_BUSY');lease.close();expect(()=>FileUploadLease.acquire(f.root,upload)).toThrow('UPLOAD_LEASE_HELD');const resumed=f.acquire();resumed.cancelBeforeDispatch();const next=FileUploadLease.acquire(f.root,upload);next.cancelBeforeDispatch();
 });
 it('rejects changed provider inventory and cannot finalize or cancel an unresolved intent',async()=>{
  const f=fixture(),lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await expect(lease.reconcile(async()=>({snapshot:{...f.snapshot,unrelated:true},evidenceDigest:'b'.repeat(64)}),f.signal)).rejects.toThrow('QUEUE_ADMISSION_PROVIDER_CHANGED');await expect(lease.finalize(f.target,async()=>f.snapshot,f.signal)).rejects.toThrow('QUEUE_ADMISSION_VERIFICATION_REQUIRED');expect(()=>lease.release()).toThrow();expect(()=>lease.cancelBeforeDispatch()).toThrow();expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
 });
 it('rechecks provider inventory before finalization even after successful reconciliation',async()=>{
  const f=fixture(),lease=f.acquire();await observed(f,lease);await expect(lease.finalize(f.target,async()=>({changed:true}),f.signal)).rejects.toThrow('QUEUE_ADMISSION_PROVIDER_CHANGED');expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);expect(existsSync(join(f.root,'deployment-lock','queue-finalization.json'))).toBe(false);
 });
 it('resumes a durable finalization receipt before canonical replacement',async()=>{
  const f=fixture();let lease=f.acquire();await observed(f,lease);writeFileSync(join(f.root,'deployment-lock','queue-finalization.json'),JSON.stringify({v:1,planHash:queueSnapshotHash(f.plan),beforeCanonical:f.canonical,canonical:f.target})+'\n',{mode:0o600});lease.close();lease=f.acquire();await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.target);
 });
 it('resumes after canonical replacement without repeating provider dispatch',async()=>{
  const f=fixture();let lease=f.acquire();await observed(f,lease);await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.close();lease=f.acquire();const send=vi.fn();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).not.toHaveBeenCalled();await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();
 });
 it('rejects unrelated canonical changes even when their digest was put into a plan',async()=>{
  const f=fixture();const bad=JSON.stringify({...JSON.parse(f.target),productionVersion:'changed'})+'\n';f.plan.targetCanonicalSha256=queueAdmissionHash(bad);const lease=f.acquire();await observed(f,lease);await expect(lease.finalize(bad,async()=>f.snapshot,f.signal)).rejects.toThrow('QUEUE_ADMISSION_UNRELATED_CANONICAL_CHANGE');
 });
 it('rejects a forged recovery receipt that changes unrelated canonical fields',async()=>{
  const f=fixture();const bad=JSON.stringify({...JSON.parse(f.target),productionVersion:'changed'})+'\n';f.plan.targetCanonicalSha256=queueAdmissionHash(bad);const lease=f.acquire();await observed(f,lease);writeFileSync(join(f.root,'deployment-lock','queue-finalization.json'),JSON.stringify({v:1,planHash:queueSnapshotHash(f.plan),beforeCanonical:f.canonical,canonical:bad})+'\n',{mode:0o600});lease.close();expect(()=>f.acquire()).toThrow('QUEUE_ADMISSION_FINALIZATION_INVALID');
 });
 it('rejects canonical, ownership and permissions drift without overwriting it',()=>{
  const f=fixture(),lease=f.acquire();writeFileSync(join(f.root,'latest-verified-deployment.json'),'{}\n');expect(()=>lease.assert()).toThrow('QUEUE_ADMISSION_CANONICAL_CHANGED');writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical);chmodSync(join(f.root,'latest-verified-deployment.json'),0o644);expect(()=>lease.assert()).toThrow('QUEUE_ADMISSION_PERMISSIONS');
 });
 it('rejects an altered provider proof and unexpected lock-directory files',async()=>{
  const f=fixture(),lease=f.acquire();await observed(f,lease);writeFileSync(queueSnapshotPath(f.root,f.plan.operationId),'{}\n');await expect(lease.finalize(f.target,async()=>f.snapshot,f.signal)).rejects.toThrow('QUEUE_ADMISSION_VERIFICATION_INVALID');
  const g=fixture(),other=g.acquire();writeFileSync(join(g.root,'deployment-lock','unexpected'),'x',{mode:0o600});expect(()=>other.cancelBeforeDispatch()).toThrow('QUEUE_ADMISSION_DIRECTORY_CHANGED');
 });
 it('rejects a symlink canonical and malformed plan before dispatch',()=>{
  const f=fixture();expect(()=>QueueAdmissionLease.acquire(f.root,{...f.plan,requestSha256:'invalid'})).toThrow('QUEUE_ADMISSION_PLAN_INVALID');const original=join(f.root,'saved.json');writeFileSync(original,f.canonical,{mode:0o600});rmSync(join(f.root,'latest-verified-deployment.json'));symlinkSync(original,join(f.root,'latest-verified-deployment.json'));expect(()=>f.acquire()).toThrow('QUEUE_ADMISSION_PERMISSIONS');
 });
 it('prevents overlapping operations and closing the lease while authorization is running',async()=>{
  const f=fixture(),lease=f.acquire();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),send=vi.fn(async()=>{}),pending=lease.dispatchOnce(()=>gate,send,f.signal);
  await expect(lease.dispatchOnce(async()=>{},send,f.signal)).rejects.toThrow('QUEUE_ADMISSION_IN_PROGRESS');expect(()=>lease.close()).toThrow('QUEUE_ADMISSION_IN_PROGRESS');release();await pending;expect(send).toHaveBeenCalledTimes(1);
 });
});
