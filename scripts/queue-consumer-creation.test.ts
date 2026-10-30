import {afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {QueueAdmissionLease,queueAdmissionHash,queueSnapshotHash,queueSnapshotPath,queueConsumerCreationExpectedSnapshot,queueConsumerCreationRequest,type QueueAdmissionPlan} from './queue-admission-lease.ts';
import {FileUploadLease} from './release-upload-lease.ts';
const roots:string[]=[],leases:QueueAdmissionLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))try{lease.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-consumer-create-')));chmodSync(root,0o700);roots.push(root);
 const operationId=randomUUID(),baselinePath=join(root,'baseline.json'),key='staging-denial-0' as const;
 const bindings=[{type:'queue',name:'DENIAL_RANGE_0',queue_name:'porchday-'+key},...Object.entries({SESSION_DENIAL_WRITER_V1:'true',SESSION_DENIAL_CLEANUP_V1:'true',SESSION_DENIAL_PARTITIONS_V1:'active'}).map(([name,text])=>({type:'plain_text',name,text}))];
 const before={queues:{[key]:{queue_id:'a'.repeat(32),queue_name:'porchday-'+key,settings:{delivery_delay:0,delivery_paused:true,message_retention_period:345600},consumers:[],consumers_total_count:0,producers:[{script:'porchday-staging',type:'worker'}],producers_total_count:1}},workers:{staging:{resources:{bindings},settings:{bindings}},production:{version:'unchanged'}},domains:[],schedules:{}};
 const canonical=JSON.stringify({stagingVersion:'unchanged',productionVersion:'unchanged',latestProviderSnapshot:baselinePath})+'\n',target=JSON.stringify({...JSON.parse(canonical),latestProviderSnapshot:queueSnapshotPath(root,operationId)})+'\n';
 writeFileSync(baselinePath,JSON.stringify(before),{mode:0o600});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const expected=queueConsumerCreationExpectedSnapshot(before,key),snapshot=structuredClone(expected);snapshot.queues[key].consumers[0].consumer_id='b'.repeat(32);
 const plan:QueueAdmissionPlan={operationId,worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:queueAdmissionHash(canonical),targetCanonicalSha256:queueAdmissionHash(target),expectedSnapshotSha256:queueSnapshotHash(expected),requestSha256:queueAdmissionHash(JSON.stringify(queueConsumerCreationRequest(key))),consumerCreation:{key,baselineSnapshotSha256:queueSnapshotHash(before)}};
 const acquire=()=>{const lease=QueueAdmissionLease.acquire(root,plan);leases.push(lease);return lease;};return{root,key,plan,canonical,target,baselinePath,before,snapshot,acquire,signal:AbortSignal.timeout(10000)};
}
it('reconciles lost replies once, retains the assigned ID and resumes after canonical replacement',async()=>{
 const f=fixture(),send=vi.fn(async()=>{throw Error('lost reply');});let lease=f.acquire();
 expect(JSON.parse(readFileSync(join(f.root,'deployment-lock/owner.json'),'utf8')).protocol).toBe('porchday-queue-consumer-creation-v1');
 expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');lease.close();lease=f.acquire();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');
 await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.close();lease=f.acquire();await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();
 const proof=JSON.parse(readFileSync(queueSnapshotPath(f.root,f.plan.operationId),'utf8'));expect(proof).toEqual(f.snapshot);expect(JSON.stringify(proof)).not.toContain('provider-assigned');expect(send).toHaveBeenCalledTimes(1);expect(()=>f.acquire()).toThrow('ALREADY_TERMINAL');
});
it('resumes a durable receipt before canonical replacement',async()=>{
 const f=fixture();let lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);
 writeFileSync(join(f.root,'deployment-lock/queue-finalization.json'),JSON.stringify({v:1,planHash:queueSnapshotHash(f.plan),beforeCanonical:f.canonical,canonical:f.target}),{mode:0o600});lease.close();lease=f.acquire();const send=vi.fn();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');await lease.finalize(f.target,async()=>f.snapshot,f.signal);lease.release();expect(send).not.toHaveBeenCalled();expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.target);
});
it.each(['unpause','producer','wrong worker','wrong DLQ','concurrency','retry','batch','queue ID','consumer ID','extra consumer','hidden consumer','other worker','other queue'])('rejects %s drift without replay',async kind=>{
 const f=fixture(),lease=f.acquire(),send=vi.fn(async()=>{});await lease.dispatchOnce(async()=>{},send,f.signal);const bad=structuredClone(f.snapshot) as any,q=bad.queues[f.key],consumer=q.consumers[0];
 if(kind==='unpause')q.settings.delivery_paused=false;if(kind==='producer')q.producers=[];if(kind==='wrong worker')consumer.script='porchday-production';if(kind==='wrong DLQ')consumer.dead_letter_queue='other';if(kind==='concurrency')consumer.settings.max_concurrency=2;if(kind==='retry')consumer.settings.max_retries=1;if(kind==='batch')consumer.settings.batch_size=2;if(kind==='queue ID')q.queue_id='e'.repeat(32);if(kind==='consumer ID')consumer.consumer_id='invalid';if(kind==='extra consumer'){q.consumers.push(consumer);q.consumers_total_count=2;}if(kind==='hidden consumer')q.consumers_total_count=2;if(kind==='other worker')bad.workers.production.version='changed';if(kind==='other queue')bad.queues.other=q;
 await expect(lease.reconcile(async()=>({snapshot:bad,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow();expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
});
it.each(['unpaused','unregistered','consumer exists','binding absent','latest binding absent','isolated mode','cleanup disabled','wrong environment','forged request','forged snapshot','both protocols'])('rejects %s before retaining a lock',kind=>{
 const f=fixture(),before=structuredClone(f.before) as any;
 if(kind==='unpaused')before.queues[f.key].settings.delivery_paused=false;if(kind==='unregistered')before.queues[f.key].producers=[];if(kind==='consumer exists')before.queues[f.key].consumers_total_count=1;if(kind==='binding absent')before.workers.staging.resources.bindings=[];if(kind==='latest binding absent')before.workers.staging.settings.bindings=[];if(kind==='isolated mode')before.workers.staging.resources.bindings.push({type:'plain_text',name:'SESSION_DENIAL_QUEUE_TOPOLOGY_V1',text:'isolated'});if(kind==='cleanup disabled')before.workers.staging.resources.bindings.find((b:any)=>b.name==='SESSION_DENIAL_CLEANUP_V1').text='false';
 writeFileSync(f.baselinePath,JSON.stringify(before));f.plan.consumerCreation!.baselineSnapshotSha256=queueSnapshotHash(before);
 if(kind==='wrong environment')f.plan.consumerCreation!.key='production-denial-0';if(kind==='forged request')f.plan.requestSha256='f'.repeat(64);if(kind==='forged snapshot')f.plan.expectedSnapshotSha256='e'.repeat(64);if(kind==='both protocols')f.plan.creation={...f.plan.consumerCreation!};
 expect(()=>f.acquire()).toThrow();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
});
it('does not cancel or resend after an empty read following intent',async()=>{
 const f=fixture(),lease=f.acquire(),send=vi.fn(async()=>{throw Error('unknown');});await lease.dispatchOnce(async()=>{},send,f.signal);await expect(lease.reconcile(async()=>({snapshot:f.before,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow();expect(()=>lease.cancelBeforeDispatch()).toThrow('CANCELLATION_UNSAFE');expect(await lease.dispatchOnce(async()=>{},send,f.signal)).toBe('reconcile');expect(send).toHaveBeenCalledTimes(1);
});
it('pins the assigned ID through subsequent reconciliation and finalization',async()=>{
 const f=fixture(),lease=f.acquire();await lease.dispatchOnce(async()=>{},async()=>{},f.signal);await lease.reconcile(async()=>({snapshot:f.snapshot,evidenceDigest:'d'.repeat(64)}),f.signal);const replacement=structuredClone(f.snapshot);replacement.queues[f.key].consumers[0].consumer_id='e'.repeat(32);await expect(lease.reconcile(async()=>({snapshot:replacement,evidenceDigest:'d'.repeat(64)}),f.signal)).rejects.toThrow('PROOF_CHANGED');await expect(lease.finalize(f.target,async()=>replacement,f.signal)).rejects.toThrow('PROVIDER_CHANGED');
});
it('rejects baseline changes before dispatch and excludes concurrent uploads',async()=>{
 const f=fixture(),lease=f.acquire();expect(()=>FileUploadLease.acquire(f.root,{operationId:randomUUID(),worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:f.plan.canonicalSha256,evidenceDigest:'e'.repeat(64)})).toThrow();writeFileSync(f.baselinePath,JSON.stringify({...f.before,domains:['drift']}));const send=vi.fn();await expect(lease.dispatchOnce(async()=>{},send,f.signal)).rejects.toThrow('BASELINE_CHANGED');expect(send).not.toHaveBeenCalled();lease.cancelBeforeDispatch();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
});
