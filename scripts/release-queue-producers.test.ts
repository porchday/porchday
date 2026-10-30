import {expect,it} from 'vitest';
import {registeredQueueInventory} from './release-queue-producers.ts';
import {assertInactiveUploadSnapshot,releaseSettings} from './cloudflare-release-reader.ts';
import {assertActivationInventory,type CompletedUpload} from './release-activation-evidence.ts';
import {validateUploadQueueRegistration,uploadReconciliationEvidenceHash,type UploadReconciliationEvidence} from './release-upload-reconcile.ts';
import {createPreparedUpload} from './release-upload.ts';
import type {DeploymentPlan} from './deployment-recovery.ts';
const baseline='11111111-0000-4000-8000-000000000000',candidate='22222222-0000-4000-8000-000000000000',source='a'.repeat(40);
function fixture(){
 const keys=[0,1,2].map(i=>'staging-denial-'+i),prior=[{type:'plain_text',name:'SESSION_DENIAL_PARTITIONS_V1',text:'active'}],next=[...prior,...keys.map((key,i)=>({type:'queue',name:'DENIAL_RANGE_'+i,queue_name:'porchday-'+key}))];
 const queues=Object.fromEntries(keys.map((key,i)=>[key,{queue_id:String(i+1).repeat(32),queue_name:'porchday-'+key,settings:{delivery_delay:0,delivery_paused:true,message_retention_period:345600},consumers:[],consumers_total_count:0,producers:[],producers_total_count:0}]));
 const registration={keys},before={workers:Object.fromEntries(['staging','staging-edge','monitor-staging','production','monitor-production','production-edge'].map(key=>[key,{active:baseline,latest:baseline,settings:releaseSettings({bindings:prior}),resources:{script:{etag:'same'},script_runtime:{},bindings:prior}}])),queues,domains:[],schedules:{}};
 const after=structuredClone(before);after.workers.staging.latest=candidate;after.workers.staging.settings=releaseSettings({bindings:next});
 const registered=structuredClone(queues);for(const q of Object.values(registered)){Object.assign(q,{producers:[{type:'worker',script:'porchday-staging'}],producers_total_count:1});}
 const options={before:queues,observed:registered,worker:'staging',beforeBindings:prior,afterBindings:next,registration,phase:'upload' as const};
 const evidence={worker:'porchday-staging',before,settings:after.workers.staging.settings,resources:{...before.workers.staging.resources,bindings:next},queueProducerRegistration:registration} as unknown as UploadReconciliationEvidence;
 return{keys,prior,next,queues,registration,before,after,registered,options,evidence};
}
it('retains exact observed registration during upload and requires all candidate registrations',()=>{
 const f=fixture(),copy=structuredClone(f);expect(registeredQueueInventory(f.options)).toEqual(f.registered);expect(registeredQueueInventory({...f.options,observed:f.queues})).toEqual(f.queues);
 expect(registeredQueueInventory({...f.options,phase:'candidate'})).toEqual(f.registered);expect(()=>registeredQueueInventory({...f.options,observed:f.queues,phase:'candidate'})).toThrow('REGISTRATION_INVALID');
 for(const observed of [f.queues,f.registered])expect(registeredQueueInventory({...f.options,observed,phase:'baseline'})).toEqual(observed);expect(f).toEqual(copy);
});
it.each(['foreign producer','duplicate producer','hidden producer','consumer','unpause','retention','identity','new queue','removed queue','extra field'])('rejects %s rather than hiding unrelated state',kind=>{
 const f=fixture(),observed:Record<string,any>=structuredClone(f.registered),q=observed[f.keys[0]];
 if(kind==='foreign producer')q.producers[0].script='porchday-production';if(kind==='duplicate producer'){q.producers.push(q.producers[0]);q.producers_total_count=2;}if(kind==='hidden producer')q.producers_total_count=2;
 if(kind==='consumer'){q.consumers=[{script:'porchday-staging'}];q.consumers_total_count=1;}if(kind==='unpause')q.settings.delivery_paused=false;if(kind==='retention')q.settings.message_retention_period=60;if(kind==='identity')q.queue_id='f'.repeat(32);if(kind==='new queue')observed.extra=q;if(kind==='removed queue')delete observed[f.keys[2]];if(kind==='extra field')q.extra=true;
 expect(()=>registeredQueueInventory({...f.options,observed})).toThrow('REGISTRATION_INVALID');
});
it.each(['wrong environment','duplicate key','unknown key','empty policy','policy field','wrong binding','duplicate binding','removed old binding','new other binding','isolated','already attached','already producer'])('rejects unsafe plan: %s',kind=>{
 const f=fixture(),o:any=structuredClone(f.options);
 if(kind==='wrong environment')o.worker='production';if(kind==='duplicate key')o.registration.keys[1]=o.registration.keys[0];if(kind==='unknown key')o.registration.keys[0]='staging-jobs';if(kind==='empty policy')o.registration.keys=[];if(kind==='policy field')o.registration.other=true;
 if(kind==='wrong binding')o.afterBindings[1].queue_name='porchday-production-denial-0';if(kind==='duplicate binding')o.afterBindings.push(o.afterBindings[1]);if(kind==='removed old binding')o.afterBindings.shift();if(kind==='new other binding')o.afterBindings.push({type:'plain_text',name:'UNRELATED',text:'changed'});if(kind==='isolated'){const flag={type:'plain_text',name:'SESSION_DENIAL_QUEUE_TOPOLOGY_V1',text:'isolated'};o.beforeBindings.push(flag);o.afterBindings.push(flag);}if(kind==='already attached')o.before[f.keys[0]].consumers_total_count=1;if(kind==='already producer')o.before[f.keys[0]]=f.registered[f.keys[0]];
 expect(()=>registeredQueueInventory(o)).toThrow('REGISTRATION_INVALID');
});
it('requires explicit hashed authorization and preserves every unrelated upload field',()=>{
 const f=fixture();f.after.queues=f.registered;expect(()=>assertInactiveUploadSnapshot(f.before,f.after,'staging',candidate,f.after.workers.staging.settings)).toThrow('INVENTORY_CHANGED');
 assertInactiveUploadSnapshot(f.before,f.after,'staging',candidate,f.after.workers.staging.settings,f.registration);
 const withoutRegistration={...f.evidence};delete withoutRegistration.queueProducerRegistration;expect(uploadReconciliationEvidenceHash(f.evidence)).not.toBe(uploadReconciliationEvidenceHash(withoutRegistration));
 f.after.workers.production.active=candidate;expect(()=>assertInactiveUploadSnapshot(f.before,f.after,'staging',candidate,f.after.workers.staging.settings,f.registration)).toThrow('INVENTORY_CHANGED');
});
it('validates the registration before preparation or any dispatch and rejects stale active bindings',()=>{
 const f=fixture();validateUploadQueueRegistration(f.evidence);
 f.before.workers.staging.resources.bindings=[];
 expect(()=>validateUploadQueueRegistration(f.evidence)).toThrow('REGISTRATION_INVALID');
 const options={evidence:{...f.evidence,preparation:{}},database:{}} as unknown as Parameters<typeof createPreparedUpload>[0];
 expect(()=>createPreparedUpload(options)).toThrow('REGISTRATION_INVALID');
});
it('verifies candidate registration and rollback through the actual activation comparator',()=>{
 const f=fixture(),upload={worker:'porchday-staging',source,candidateVersion:candidate,baselineVersion:baseline,baselineResources:f.before.workers.staging.resources,candidateResources:f.evidence.resources,inventory:f.after,queueProducerRegistration:f.registration,queueProducerBaseline:f.queues} as CompletedUpload;
 const plan={worker:upload.worker,candidateSource:source,candidateVersion:candidate,baselineVersion:baseline} as DeploymentPlan;
 const active=structuredClone(f.after);active.workers.staging.active=candidate;active.workers.staging.resources=f.evidence.resources as typeof active.workers.staging.resources;active.queues=f.registered;
 assertActivationInventory(upload,plan,candidate,active);expect(()=>assertActivationInventory(upload,plan,candidate,{...active,queues:f.queues})).toThrow('REGISTRATION_INVALID');
 for(const queues of [f.queues,f.registered])assertActivationInventory(upload,plan,baseline,{...f.after,queues});
 const bad=structuredClone(active);bad.workers.production.latest=candidate;expect(()=>assertActivationInventory(upload,plan,candidate,bad)).toThrow('INVENTORY_CHANGED');
});
