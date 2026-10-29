import {createContinuityGate} from './release-continuity-gate.ts';
import type {ContinuityCommandEvent} from './release-continuity-command.ts';
import {readActivationManifest,executeActivationManifest,executeActivationWithContinuity,executeMonitorActivationManifest,executeMonitorActivationWithContinuity,type ActivationManifest} from './release-activation-cli.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {spawnSync} from 'node:child_process';
import {finalizePreparedActivation} from './release-activation-finalize.ts';
import {activationReviewHash,verifyActivationReview,createReviewedActivationPorts,compatibilityChecks,type ActivationReviewEvidence,type CompatibilityReview} from './release-activation-review.ts';
import {publicAssetManifestHash} from './release-assets-verify.ts';
import {describe,it,expect,vi} from 'vitest';
import {createActivationStateVerifier,createPreparedActivationPorts} from './release-activation-state.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync,chmodSync,symlinkSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileUploadLease,uploadPlanHash} from './release-upload-lease.ts';
import {comparableReleaseResources,uploadReconciliationEvidenceHash} from './release-upload-reconcile.ts';
import {releaseSettings} from './cloudflare-release-reader.ts';
import {readCompletedUpload,assertActivationInventory} from './release-activation-evidence.ts';
import type {UploadManifest} from './release-upload-cli.ts';
import {recoverDeployment,deploymentPlanHash,rollbackOperationId,type DeploymentPlan,type RecoveryState,type DeploymentPorts} from './deployment-recovery.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
async function fixture(options:{monitor?:boolean;complete?:boolean;frontend?:boolean;production?:boolean;mutate?:(proof:any)=>void}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-activation-evidence-'))),source='a'.repeat(40),environment=options.production?'production':'staging',worker='porchday-'+(options.monitor?'monitor-':'')+environment+(options.frontend?'-edge':''),key=(options.monitor?'monitor-':'')+environment+(options.frontend?'-edge':''),entry=options.frontend?'edge.js':'index.js';
 const canonical=JSON.stringify({stagingVersion:id(1),stagingRuntimeSource:'b'.repeat(40),compatibleRollbackVersions:{staging:id(1),'monitor-staging':id(1)},...(options.monitor?{monitorVersions:{staging:id(1)},monitorSources:{staging:'b'.repeat(40)}}:{}),edgeRouting:{stagingEnabled:!!options.frontend,stagingFrontendVersion:id(1),stagingFrontendSource:'b'.repeat(40)}});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const settings=releaseSettings({bindings:[]}),resources={script:{etag:'baseline',handlers:['fetch']},script_runtime:{compatibility_date:'2026-10-24'},bindings:[]};
 const before={workers:Object.fromEntries(['staging','staging-edge','production','production-edge','monitor-staging','monitor-production'].map(k=>[k,{active:id(1),latest:id(1),settings,resources}])),domains:[],queues:{},schedules:{}};
 const schema={version:1 as const,migrations:['000_initial.sql'],functionsSha256:'b'.repeat(64),columnsSha256:'c'.repeat(64)},ci={verify:{runId:1,attempt:1,workflowSha256:'d'.repeat(64)},history:{runId:2,attempt:1,workflowSha256:'e'.repeat(64)}};
 const files={[entry]:'f'.repeat(64),[entry+'.map']:'0'.repeat(64)},artifacts={directory:root,entry,hashes:files,sourcePaths:['apps/api/src/index.ts']} as UploadManifest['evidence']['artifacts'];
 const evidence:UploadManifest['evidence']={version:1,worker,source,before,settings,resources,databaseBranchId:'synthetic',schema,ci,artifacts,preparation:{configPath:join(root,'config.json'),configSha256:'1'.repeat(64),wrangler:{} as any,inputs:{bundle:{directory:root,entry,files},assets:null},toolingSource:'2'.repeat(40),toolingCi:ci,assetSources:[]}};
 const plan={operationId:id(3),worker,source,canonicalSha256:hash(canonical),evidenceDigest:uploadReconciliationEvidenceHash(evidence)};
 const manifest:UploadManifest={version:1,root,workspace:root,proofDirectory:root,privateLogDirectory:root,plan,evidence,queues:{} as any};
 const inventory=structuredClone(before);inventory.workers[key].latest=id(2);
 const proof={version:1,planHash:uploadPlanHash(plan),candidate:{version:id(2),resources:{...resources,script:{...resources.script,etag:'candidate'}}},inventory,schema,ci:{source},provenance:{source,files:{'apps/api/src/index.ts':'3'.repeat(64)}},artifacts:{entry,hashes:files},preparation:{toolingCi:{source:evidence.preparation.toolingSource}}};
 options.mutate?.(proof);const proofPath=join(root,'proof.json'),bytes=JSON.stringify(proof);writeFileSync(proofPath,bytes,{mode:0o600});
 const lease=FileUploadLease.acquire(root,plan);await lease.dispatchOnce(async()=>{},async()=>{},AbortSignal.timeout(5000));
 if(options.complete!==false){await lease.reconcile(async()=>({version:id(2),evidenceDigest:hash(bytes)}),AbortSignal.timeout(5000));lease.release();}else lease.close();
 const deployment:DeploymentPlan={operationId:id(4),worker,candidateVersion:id(2),candidateSource:source,baselineVersion:id(1),baselineDeploymentId:id(5),compatibleRollbackVersions:[id(1)],evidenceDigest:'4'.repeat(64),...(options.frontend?{backendVersion:id(1),backendReaderFloor:id(1)}:{})};
 return{root,manifest,proofPath,proof,deployment,key,close:()=>{lease.close();rmSync(root,{recursive:true,force:true});}};
}
describe('verified inactive-upload handoff',()=>{
 it('reads a real archived lease without provider calls or a new lock',async()=>{const f=await fixture();try{const upload=readCompletedUpload(f.manifest,f.proofPath);expect(upload.candidateVersion).toBe(id(2));expect(upload.proofSha256).toBe(hash(readFileSync(f.proofPath)));expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).stagingVersion).toBe(id(1));f.manifest.evidence.source='f'.repeat(40);expect(upload.source).toBe('a'.repeat(40));}finally{f.close();}});
 it('refuses an unresolved dispatch even with a plausible proof file',async()=>{const f=await fixture({complete:false});try{expect(()=>readCompletedUpload(f.manifest,f.proofPath)).toThrow('NOT_COMPLETED');}finally{f.close();}});
 it('rejects proof bytes changed after archive',async()=>{const f=await fixture();try{writeFileSync(f.proofPath,JSON.stringify({...f.proof,version:2}));expect(()=>readCompletedUpload(f.manifest,f.proofPath)).toThrow('PROOF_CHANGED');}finally{f.close();}});
 it.each(['version','source','schema','resources','inventory','files','tooling'])('rejects inconsistent archived %s evidence',async kind=>{const f=await fixture({mutate:p=>{if(kind==='version')p.candidate.version=id(9);if(kind==='source')p.provenance.source='9'.repeat(40);if(kind==='schema')p.schema={...p.schema,functionsSha256:'9'.repeat(64)};if(kind==='resources')p.candidate.resources={...p.candidate.resources,bindings:[{name:'unexpected',type:'plain_text',text:'true'}]};if(kind==='inventory')p.inventory.workers.production.active=id(9);if(kind==='files')p.provenance.files={};if(kind==='tooling')p.preparation.toolingCi.source='9'.repeat(40);}});try{expect(()=>readCompletedUpload(f.manifest,f.proofPath)).toThrow();}finally{f.close();}});
 it('rejects manifest drift, public proof files and symlinks',async()=>{const f=await fixture();try{f.manifest.evidence.databaseBranchId='changed';expect(()=>readCompletedUpload(f.manifest,f.proofPath)).toThrow('EVIDENCE_CHANGED');f.manifest.evidence.databaseBranchId='synthetic';chmodSync(f.proofPath,0o644);expect(()=>readCompletedUpload(f.manifest,f.proofPath)).toThrow('PERMISSIONS');chmodSync(f.proofPath,0o600);const link=join(f.root,'link.json');symlinkSync(f.proofPath,link);expect(()=>readCompletedUpload(f.manifest,link)).toThrow('PATH_INVALID');}finally{f.close();}});
 it.each([false,true])('limits backend/frontend activation and rollback to their pinned resource changes (frontend=%s)',async frontend=>{const f=await fixture({frontend});try{const upload=readCompletedUpload(f.manifest,f.proofPath);for(const version of [id(1),id(2)]){const expected=structuredClone(upload.inventory);expected.workers[f.key].active=version;expected.workers[f.key].resources=version===id(2)?upload.candidateResources:upload.baselineResources;expect(()=>assertActivationInventory(upload,f.deployment,version,expected)).not.toThrow();const drift=structuredClone(expected);drift.workers.production.latest=id(8);expect(()=>assertActivationInventory(upload,f.deployment,version,drift)).toThrow('INVENTORY_CHANGED');}expect(()=>assertActivationInventory(upload,{...f.deployment,candidateVersion:id(8)},id(1),upload.inventory)).toThrow('PLAN_CHANGED');if(frontend)expect(()=>assertActivationInventory(upload,{...f.deployment,backendVersion:id(8)},id(1),upload.inventory)).toThrow('BACKEND_CHANGED');}finally{f.close();}});
});

describe('shared resource comparison',()=>{
 it('ignores binding order and object property order, preserving binding values',()=>{
  const base={script:{etag:'one',handlers:['fetch']},script_runtime:{compatibility_date:'2026-10-24'},bindings:[{name:'A',type:'plain_text',text:'one'},{type:'plain_text',name:'B',text:'two'}]};
  const reordered={...base,script:{...base.script,etag:'two'},bindings:[{text:'two',name:'B',type:'plain_text'},{text:'one',type:'plain_text',name:'A'}]};
  expect(comparableReleaseResources(base)).toEqual(comparableReleaseResources(reordered));
  reordered.bindings[0].text='changed';
  expect(comparableReleaseResources(base)).not.toEqual(comparableReleaseResources(reordered));
 });
});

async function stateFixture(frontend=false){
 const f=await fixture({frontend}),lease=FileDeploymentLease.acquire(f.root,f.deployment);
 let observed=structuredClone(f.proof.inventory);
 const checks={tooling:vi.fn(async()=>({source:'d'.repeat(40)})),ci:vi.fn(async(input:any)=>({source:input.source,repository:'porchday/porchday',runs:[]})),schema:vi.fn(async()=>structuredClone(f.manifest.evidence.schema))};
 const reader={snapshot:vi.fn(async()=>structuredClone(observed))};
 const upload=readCompletedUpload(f.manifest,f.proofPath);
 const evidence={version:1 as const,uploadPlanHash:upload.uploadPlanHash,uploadProofSha256:upload.proofSha256,tooling:{source:'d'.repeat(40),ci:f.manifest.evidence.ci},baseline:{source:'b'.repeat(40),ci:f.manifest.evidence.ci}};
 const options={workspace:f.root,plan:f.deployment,manifest:f.manifest,proofPath:f.proofPath,evidence,lease,reader,database:{connection:'synthetic',branchId:'synthetic'},checks};
 const gate=createActivationStateVerifier(options);
 return{...f,lease,checks,reader,evidence,options,gate,active(version:string){observed.workers[f.key].active=version;observed.workers[f.key].resources=version===id(2)?upload.candidateResources:upload.baselineResources;},drift(){observed.workers.production.latest=id(9);},close:()=>{lease.close();f.close();}};
}
describe('fresh activation state under the real deployment lease',()=>{
 it.each([false,true])('checks candidate, baseline and current tooling CI independently (frontend=%s)',async frontend=>{const f=await stateFixture(frontend);try{
  await f.gate.authorizeState(f.deployment,'activate',AbortSignal.timeout(5000));
  expect(f.checks.ci.mock.calls.map(([input])=>input.source).sort()).toEqual(['a'.repeat(40),'b'.repeat(40),'d'.repeat(40)]);
  expect(f.checks.tooling).toHaveBeenCalledTimes(2);expect(f.reader.snapshot).toHaveBeenCalledTimes(2);
  f.active(id(2));await f.gate.authorizeState(f.deployment,'rollback',AbortSignal.timeout(5000));
  expect((await f.gate.verifyState(id(2),AbortSignal.timeout(5000))).inventory).toHaveProperty('workers.'+f.key+'.active',id(2));
  f.active(id(1));await f.gate.verifyState(id(1),AbortSignal.timeout(5000));
 }finally{f.close();}});
 it.each(['ci','tooling','schema','inventory','proof','canonical','plan','cancel'])('rejects %s failure before authorization',async kind=>{const f=await stateFixture();try{
  if(kind==='ci')f.checks.ci.mockRejectedValue(Error('CI_FAILED'));
  if(kind==='tooling')f.checks.tooling.mockRejectedValue(Error('DIRTY'));
  if(kind==='schema')f.checks.schema.mockResolvedValue({...f.manifest.evidence.schema,columnsSha256:'9'.repeat(64)});
  if(kind==='inventory')f.drift();
  if(kind==='proof')writeFileSync(f.proofPath,'{}');
  if(kind==='canonical')writeFileSync(join(f.root,'latest-verified-deployment.json'),'{}');
  const signal=new AbortController();if(kind==='cancel')signal.abort();
  await expect(f.gate.authorizeState(kind==='plan'?{...f.deployment,evidenceDigest:'9'.repeat(64)}:f.deployment,'activate',signal.signal)).rejects.toThrow();
 }finally{f.close();}});
 it('rechecks schema and inventory after CI rather than trusting the early reads',async()=>{const f=await stateFixture();try{
  f.checks.tooling.mockImplementationOnce(async()=>({source:'d'.repeat(40)})).mockImplementationOnce(async()=>{f.drift();return{source:'d'.repeat(40)};});
  await expect(f.gate.authorizeState(f.deployment,'activate',AbortSignal.timeout(5000))).rejects.toThrow('INVENTORY_CHANGED');
 }finally{f.close();}});
 it('holds completion until all independent reads settle after a failed CI check',async()=>{const f=await stateFixture();try{
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  f.checks.ci.mockRejectedValue(Error('CI_FAILED'));f.reader.snapshot.mockImplementation(async()=>{await pending;return structuredClone(f.proof.inventory);});
  let finished=false;const result=f.gate.authorizeState(f.deployment,'activate',AbortSignal.timeout(5000)).then(()=>{finished=true;},()=>{finished=true;});
  await vi.waitFor(()=>expect(f.reader.snapshot).toHaveBeenCalled());expect(finished).toBe(false);release();await result;expect(finished).toBe(true);
 }finally{f.close();}});
 it('snapshots inputs and rejects baseline-source or upload receipt mismatch',async()=>{const f=await stateFixture();try{
  f.options.evidence.tooling.source='e'.repeat(40);f.options.manifest.evidence.source='e'.repeat(40);
  await f.gate.authorizeState(f.deployment,'activate',AbortSignal.timeout(5000));expect(f.checks.tooling.mock.calls[0][1]).toBe('d'.repeat(40));
  const fresh={...f.options,manifest:{...f.manifest,evidence:{...f.manifest.evidence,source:'a'.repeat(40)}}};
  expect(()=>createActivationStateVerifier({...fresh,evidence:{...f.evidence,uploadProofSha256:'f'.repeat(64)}})).toThrow('EVIDENCE_CHANGED');
  const bad=createActivationStateVerifier({...fresh,evidence:{...f.evidence,baseline:{...f.evidence.baseline,source:'e'.repeat(40)}}});
  await expect(bad.authorizeState(f.deployment,'activate',AbortSignal.timeout(5000))).rejects.toThrow('BASELINE_SOURCE_CHANGED');
 }finally{f.close();}});
 it('refuses wrong active versions and changed resources when verifying a journey result',async()=>{const f=await stateFixture();try{
  await expect(f.gate.verifyState(id(2),AbortSignal.timeout(5000))).rejects.toThrow('INVENTORY_CHANGED');
  await expect(f.gate.verifyState(id(9),AbortSignal.timeout(5000))).rejects.toThrow('VERSION_CHANGED');
  f.active(id(2));f.drift();await expect(f.gate.verifyState(id(2),AbortSignal.timeout(5000))).rejects.toThrow('INVENTORY_CHANGED');
 }finally{f.close();}});
});

describe('prepared activation controller composition',()=>{
 it.each(['healthy','rollback','compatibility-rejected','drift-during-journey'])('preserves lease/state gates and single dispatch (%s)',async scenario=>{
  const f=await stateFixture();try{
   let state:RecoveryState|null=null,observed={version:id(1),deploymentId:id(5),operationId:null as string|null};
   const journal={read:async()=>structuredClone(state),write:async(previous:RecoveryState|null,next:RecoveryState)=>{expect(previous).toEqual(state);state=structuredClone(next);}};
   const deploy=vi.fn(async(version:string,operationId:string)=>{f.active(version);observed={version,operationId,deploymentId:id(7)};throw Error('LOST_REPLY');});
   const transport:DeploymentPorts={authorize:async()=>{if(scenario==='compatibility-rejected')throw Error('COMPATIBILITY_UNVERIFIED');},observe:async()=>({...observed}),deploy,verify:async(version)=>{if(scenario==='drift-during-journey')f.drift();return scenario==='rollback'&&version===id(2)?'unhealthy':'healthy';}};
   const ports=createPreparedActivationPorts({...f.options,journal,ports:transport});
   if(scenario==='compatibility-rejected'){
    await expect(recoverDeployment(f.deployment,journal,ports)).rejects.toThrow('COMPATIBILITY_UNVERIFIED');expect(deploy).not.toHaveBeenCalled();
   }else{
    expect(await recoverDeployment(f.deployment,journal,ports)).toBe(scenario==='healthy'?'complete':scenario==='rollback'?'rolled-back':'verification-unavailable');
    expect(deploy).toHaveBeenCalledTimes(scenario==='rollback'?2:1);
    expect(await recoverDeployment(f.deployment,journal,ports)).toBe(scenario==='healthy'?'complete':scenario==='rollback'?'rolled-back':'verification-unavailable');
    expect(deploy).toHaveBeenCalledTimes(scenario==='rollback'?2:1);
   }
   // The adapter never finalizes canonical state merely because a transport returned.
   expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).stagingVersion).toBe(id(1));
  }finally{f.close();}
 });
});

async function reviewFixture(production=false,monitor=false,historyMinutes=10){
 const f=await fixture({production,monitor}),upload=readCompletedUpload(f.manifest,f.proofPath),path=join(f.root,'compatibility.json'),testPath=join(f.root,'test-result.json');
 const result=JSON.stringify({synthetic:true,passed:true});writeFileSync(testPath,result,{mode:0o600});
 const assets={candidate:{source:'a'.repeat(40),files:{'app.js':'1'.repeat(64)}},baseline:{source:'b'.repeat(40),files:{'app.js':'2'.repeat(64)}}};
 const review:CompatibilityReview={version:1,worker:f.deployment.worker,candidate:{source:'a'.repeat(40),version:id(2)},baseline:{source:'b'.repeat(40),version:id(1)},schema:f.manifest.evidence.schema,publicAssets:{candidate:publicAssetManifestHash(assets.candidate),baseline:publicAssetManifestHash(assets.baseline)},checks:Object.fromEntries(compatibilityChecks.map(name=>[name,{status:'passed',basis:'Synthetic fixture for '+name,evidence:[{path:testPath,sha256:hash(result)}]}])) as CompatibilityReview['checks']};
 const evidence:ActivationReviewEvidence={version:1,state:{version:1,uploadPlanHash:upload.uploadPlanHash,uploadProofSha256:upload.proofSha256,tooling:{source:'d'.repeat(40),ci:f.manifest.evidence.ci},baseline:{source:'b'.repeat(40),ci:f.manifest.evidence.ci}},compatibility:{path,sha256:''},assets};
 const first=Math.floor(Date.now()/60000)*60000-(historyMinutes-1)*60000;
 const monitorBody=()=>{const now=Date.now(),expected=Math.floor(now/60000)-first/60000+1;return{status:'operational',last_checked_at:new Date(now).toISOString(),metrics_monitoring:'ready',availability:{status:'collecting',scope:'protected_readiness_checks',window_minutes:43200,first_observation_at:new Date(first).toISOString(),expected_minutes:expected,passed_minutes:expected-1,failed_minutes:1,unknown_minutes:0,observed_percent:100,conservative_pass_percent:Math.round((expected-1)/expected*100000)/1000}};};
 if(monitor){const pin=(name:string,value:unknown)=>{const path=join(f.root,name),bytes=JSON.stringify(value);writeFileSync(path,bytes,{mode:0o600});return{path,sha256:hash(bytes)};};evidence.monitor={baseline:pin('monitor-baseline.json',{environment:'staging',at:Date.now(),status:200,body:monitorBody()}),storageCompatibility:pin('monitor-overlap.json',{version:1,baselineSource:'b'.repeat(40),candidateSource:'a'.repeat(40),compatible:true,evidence:[{path:testPath,sha256:hash(result)}]})};}
 const plan={...f.deployment};
 function save(){const bytes=JSON.stringify(review);writeFileSync(path,bytes,{mode:0o600});evidence.compatibility.sha256=hash(bytes);plan.evidenceDigest=activationReviewHash(evidence);}
 save();return{...f,review,evidence,plan,save,testPath,monitorBody,verify:()=>verifyActivationReview(plan,f.manifest,f.proofPath,evidence)};
}
describe('reviewed compatibility evidence binding',()=>{
 it('binds scope, all required checks, retained files and asset manifests without provider access',async()=>{const f=await reviewFixture();try{expect(f.verify()).toEqual({evidenceDigest:f.plan.evidenceDigest,reviewSha256:f.evidence.compatibility.sha256,files:1,checks:[...compatibilityChecks],pendingChecks:[]});const reordered={...f.evidence,assets:{baseline:f.evidence.assets.baseline,candidate:f.evidence.assets.candidate}};expect(activationReviewHash(reordered)).toBe(f.plan.evidenceDigest);}finally{f.close();}});
 it.each(['pending','missing','empty','no-files','source','version','schema','assets','upload','tooling'])('rejects %s review drift or missing evidence',async kind=>{const f=await reviewFixture();try{
  if(kind==='pending')(f.review.checks.schemaRollback as any).status='pending';
  if(kind==='missing')delete (f.review.checks as any).nativeClientOverlap;
  if(kind==='empty')f.review.checks.webClientOverlap.basis=' ';
  if(kind==='no-files')f.review.checks.retainedAssets.evidence=[];
  if(kind==='source')f.review.baseline.source='c'.repeat(40);
  if(kind==='version')f.review.candidate.version=id(9);
  if(kind==='schema')f.review.schema={...f.review.schema,functionsSha256:'9'.repeat(64)};
  if(kind==='assets')f.review.publicAssets.candidate='9'.repeat(64);
  if(kind==='upload')f.evidence.state.uploadProofSha256='9'.repeat(64);
  f.save();if(kind==='tooling')f.evidence.state.tooling.source='c'.repeat(40);
  expect(f.verify).toThrow();
 }finally{f.close();}});
 it.each(['changed','public','symlink','conflicting-hash'])('rejects %s supporting evidence',async kind=>{const f=await reviewFixture();try{
  if(kind==='changed')writeFileSync(f.testPath,'changed');
  if(kind==='public')chmodSync(f.testPath,0o644);
  if(kind==='symlink'){const link=join(f.root,'linked.json');symlinkSync(f.testPath,link);f.review.checks.schemaRollback.evidence[0].path=link;f.save();}
  if(kind==='conflicting-hash'){f.review.checks.nativeClientOverlap.evidence[0].sha256='e'.repeat(64);f.save();}
  expect(f.verify).toThrow();
 }finally{f.close();}});
 it('rejects altered review bytes or asset proof pins even with unchanged candidate',async()=>{const f=await reviewFixture();try{
  f.plan.assetManifests={candidate:'e'.repeat(64),baseline:f.review.publicAssets.baseline};expect(f.verify).toThrow('ASSETS_CHANGED');delete f.plan.assetManifests;
  writeFileSync(f.evidence.compatibility.path,'{}');expect(f.verify).toThrow('FILE_CHANGED');
 }finally{f.close();}});
});

describe('reviewed activation composition',()=>{
 it.each([false,true])('enforces retained compatibility evidence through lost-reply recovery (tamper=%s)',async tamper=>{
  const f=await reviewFixture(),lease=FileDeploymentLease.acquire(f.root,f.plan);try{
   let state:RecoveryState|null=null,observed={version:id(1),deploymentId:id(5),operationId:null as string|null};
   const inventory=structuredClone(f.proof.inventory),journal={read:async()=>structuredClone(state),write:async(previous:RecoveryState|null,next:RecoveryState)=>{expect(previous).toEqual(state);state=structuredClone(next);}};
   const deploy=vi.fn(async(version:string,operationId:string)=>{inventory.workers[f.key].active=version;inventory.workers[f.key].resources=f.proof.candidate.resources;observed={version,operationId,deploymentId:id(7)};if(tamper)writeFileSync(f.testPath,'altered');throw Error('LOST_REPLY');});
   const ports=createReviewedActivationPorts({workspace:f.root,plan:f.plan,manifest:f.manifest,proofPath:f.proofPath,review:f.evidence,lease,journal,reader:{snapshot:async()=>structuredClone(inventory)},database:{connection:'synthetic',branchId:'synthetic'},checks:{tooling:async()=>({source:'d'.repeat(40)}),ci:async(input)=>({source:input.source,repository:'porchday/porchday',runs:[]}),schema:async()=>structuredClone(f.manifest.evidence.schema)},ports:{observe:async()=>({...observed}),deploy,verify:async()=> 'healthy'}});
   expect(await recoverDeployment(f.plan,journal,ports)).toBe(tamper?'verification-unavailable':'complete');
   expect(await recoverDeployment(f.plan,journal,ports)).toBe(tamper?'verification-unavailable':'complete');expect(deploy).toHaveBeenCalledTimes(1);
  }finally{lease.close();f.close();}
 });
});

describe('staging acceptance ordering',()=>{
 it.each([false,true])('allows scheduled hosted acceptance only before staging activation (production=%s)',async production=>{const f=await reviewFixture(production);try{
  f.review.checks.stagingAcceptance={status:'scheduled',basis:'Run hosted acceptance after this staging activation.',evidence:[]};f.save();if(production)expect(f.verify).toThrow('COMPATIBILITY_INCOMPLETE');else expect(f.verify().pendingChecks).toEqual(['stagingAcceptance']);
  f.review.checks.webClientOverlap={status:'scheduled',basis:'Not checked yet',evidence:[]};f.save();expect(f.verify).toThrow('COMPATIBILITY_INCOMPLETE');
 }finally{f.close();}});
});

async function finalizationFixture(rollback=false){
 const f=await reviewFixture();f.evidence.assets.candidate.files['app.js']=hash('candidate');f.evidence.assets.baseline.files['app.js']=hash('baseline');
 f.review.publicAssets={candidate:publicAssetManifestHash(f.evidence.assets.candidate),baseline:publicAssetManifestHash(f.evidence.assets.baseline)};f.save();f.plan.assetManifests={...f.review.publicAssets};
 const lease=FileDeploymentLease.acquire(f.root,f.plan),version=rollback?id(1):id(2),deploymentId=rollback?id(8):id(7),operationId=rollback?rollbackOperationId(f.plan.operationId):f.plan.operationId;
 const inventory=structuredClone(f.proof.inventory);inventory.workers[f.key].active=version;inventory.workers[f.key].resources=rollback?f.manifest.evidence.resources:f.proof.candidate.resources;
 const state:RecoveryState={v:1,revision:rollback?5:4,planHash:deploymentPlanHash(f.plan),phase:rollback?'rolled-back':'complete',candidateDeploymentId:id(7),...(rollback?{rollbackDeploymentId:id(8)}:{})};
 const journal={read:vi.fn(async()=>structuredClone(state)),write:async()=>{throw Error('FINALIZATION_MUST_NOT_CHANGE_JOURNAL');}};
 const reader={snapshot:vi.fn(async()=>structuredClone(inventory))},client={observe:vi.fn(async()=>({version,deploymentId,operationId}))};
 const request=vi.fn(async(_input:any,init:any)=>{expect(init?.method??'GET').toBe('GET');return new Response(rollback?'baseline':'candidate',{headers:{'content-type':'text/javascript'}});}) as any;
 const checks={tooling:async()=>{throw Error('UNEXPECTED_TOOLING');},ci:async()=>{throw Error('UNEXPECTED_CI');},schema:vi.fn(async()=>structuredClone(f.manifest.evidence.schema))};
 const options={workspace:f.root,plan:f.plan,manifest:f.manifest,proofPath:f.proofPath,review:f.evidence,lease,journal,reader,client,database:{connection:'synthetic',branchId:'synthetic'},checks,directory:f.root,fetch:request};
 return{...f,lease,state,journal,reader,client,request,checks,options,close:()=>{lease.close();f.close();}};
}
describe('read-only terminal finalization orchestration',()=>{
 it.each([false,true])('retains fresh provider/assets proofs and finalizes the terminal outcome (rollback=%s)',async rollback=>{const f=await finalizationFixture(rollback);try{
  const result=await finalizePreparedActivation(f.options,AbortSignal.timeout(5000));expect(result.status).toBe('finalized');
  const canonical=await FileDeploymentLease.completed(f.root,f.plan,f.journal);expect(canonical?.stagingVersion).toBe(rollback?id(1):id(2));expect(canonical?.stagingAssetsSource).toBe(rollback?'b'.repeat(40):'a'.repeat(40));
  expect(f.request).toHaveBeenCalledTimes(1);expect(f.reader.snapshot).toHaveBeenCalledTimes(2);expect(f.client.observe).toHaveBeenCalledTimes(2);
 }finally{f.close();}});
 it.each(['unresolved','assets','identity','inventory','journal','review','continuity'])('retains the lease and canonical baseline on %s failure',async kind=>{const f=await finalizationFixture();try{
  if(kind==='unresolved')f.journal.read.mockResolvedValue({...f.state,phase:'candidate-observed'});
  if(kind==='assets')f.request.mockResolvedValue(new Response('wrong',{headers:{'content-type':'text/javascript'}}));
  if(kind==='identity')f.client.observe.mockResolvedValue({version:id(2),deploymentId:id(9),operationId:f.plan.operationId});
  if(kind==='inventory')f.reader.snapshot.mockImplementation(async()=>{const x=structuredClone(f.proof.inventory);x.workers.production.latest=id(9);return x;});
  if(kind==='journal')f.journal.read.mockResolvedValueOnce(f.state).mockResolvedValue({...f.state,revision:99});
  if(kind==='review')writeFileSync(f.testPath,'changed');
  if(kind==='continuity')createContinuityGate(f.options.directory,f.plan).retain({kind:'sample',sample:{at:new Date().toISOString(),healthy:false}} as ContinuityCommandEvent);
  await expect(finalizePreparedActivation(f.options,AbortSignal.timeout(5000))).rejects.toThrow();
  expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).stagingVersion).toBe(id(1));expect(()=>f.lease.assert(f.plan)).not.toThrow();
 }finally{f.close();}});
 it('resumes a durable receipt after failure to archive, with no remote reads or user writes',async()=>{const f=await finalizationFixture();let resumed:FileDeploymentLease|undefined;try{
  f.lease.release=async()=>{throw Error('SIMULATED_ARCHIVE_INTERRUPTION');};
  await expect(finalizePreparedActivation(f.options,AbortSignal.timeout(5000))).rejects.toThrow('SIMULATED_ARCHIVE_INTERRUPTION');f.lease.close();
  resumed=FileDeploymentLease.acquire(f.root,f.plan);
  await expect(finalizePreparedActivation({...f.options,lease:resumed,plan:{...f.plan,candidateSource:'e'.repeat(40)}},AbortSignal.timeout(5000))).rejects.toThrow('OUTCOME_UNRESOLVED');
  f.client.observe.mockRejectedValue(Error('NO_REMOTE_READ'));f.reader.snapshot.mockRejectedValue(Error('NO_REMOTE_READ'));f.request.mockRejectedValue(Error('NO_REMOTE_READ'));f.checks.schema.mockRejectedValue(Error('NO_REMOTE_READ'));
  const calls=[f.client.observe.mock.calls.length,f.reader.snapshot.mock.calls.length,f.request.mock.calls.length,f.checks.schema.mock.calls.length];
  expect(await finalizePreparedActivation({...f.options,lease:resumed},AbortSignal.timeout(5000))).toEqual({status:'resumed-historical-finalization'});
  expect([f.client.observe.mock.calls.length,f.reader.snapshot.mock.calls.length,f.request.mock.calls.length,f.checks.schema.mock.calls.length]).toEqual(calls);
  expect((await FileDeploymentLease.completed(f.root,f.plan,f.journal))?.stagingVersion).toBe(id(2));
 }finally{resumed?.close();f.close();}});
});

async function cliFixture(monitor=false,longHistory=false){
 const f=await reviewFixture(false,monitor,longHistory?30:10),uploadPath=join(f.root,'upload-manifest.json'),probePath=join(f.root,'probe.json'),path=join(f.root,'activation-manifest.json');
 const uploadBytes=JSON.stringify(f.manifest),probeBytes=JSON.stringify({environment:'staging',healthToken:'h'.repeat(32),synthetic:{id:id(90),email:id(90)+'@example.test',password:'p'.repeat(32)}});
 writeFileSync(uploadPath,uploadBytes,{mode:0o600});writeFileSync(probePath,probeBytes,{mode:0o600});
 const execution={root:f.root,workspace:realpathSync(process.cwd()),uploadManifest:{path:uploadPath,sha256:hash(uploadBytes)},proofPath:f.proofPath,probe:{path:probePath,sha256:hash(probeBytes)},journalDirectory:join(f.root,'journal'),proofDirectory:join(f.root,'final-proofs'),journeyDirectory:join(f.root,'journeys')};
 for(const directory of [execution.journalDirectory,execution.proofDirectory,execution.journeyDirectory])mkdirSync(directory,{mode:0o700});
 f.evidence.execution=execution;f.save();const manifest:ActivationManifest={version:1,plan:f.plan,review:{...f.evidence,execution}};writeFileSync(path,JSON.stringify(manifest),{mode:0o600});
 const journal=new FileRecoveryJournal(execution.journalDirectory);
 async function advance(phase:'prepared'|'activation-intent'|'candidate-observed'|'complete'){
  const previous=await journal.read();await journal.write(previous,{v:1,revision:(previous?.revision??0)+1,phase,planHash:deploymentPlanHash(manifest.plan),...(['candidate-observed','complete'].includes(phase)?{candidateDeploymentId:id(7)}:{})});
 }
 return{...f,path,cli:manifest,journal,advance};
}
describe('activation operator command',()=>{
 it('failed observed baseline leaves the activation journal and shared lease untouched',async()=>{const f=await cliFixture();try{
  const canonical=readFileSync(join(f.root,'latest-verified-deployment.json'));
  const request=vi.fn(async()=>Response.json({}, {status:503})),events:any[]=[];
  await expect(executeActivationWithContinuity(f.cli,{}, {target:{environment:'staging',memberId:id(91),cookie:'continuity-allowed',deniedCookie:'continuity-denied',healthToken:'h'.repeat(32)},assertScope:()=>{},fetch:request,retain:async e=>{events.push(e);}},AbortSignal.timeout(5000))).rejects.toThrow('CONTINUITY_BASELINE_FAILED');
  expect(request).toHaveBeenCalledTimes(4);expect(events).toHaveLength(1);expect(await f.journal.read()).toBeNull();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  expect(readFileSync(join(f.root,'latest-verified-deployment.json'))).toEqual(canonical);
 }finally{f.close();}});
 it.each(['environment','intent','aborted'])('observed entry point rejects %s before observer requests',async failure=>{const f=await cliFixture();try{
  const request=vi.fn(),controller=new AbortController();
  if(failure==='intent'){await f.advance('prepared');await f.advance('activation-intent');}
  if(failure==='aborted')controller.abort();
  const observation={target:{environment:failure==='environment'?'production' as const:'staging' as const,memberId:id(91),cookie:'continuity-allowed',deniedCookie:'continuity-denied',healthToken:'h'.repeat(32)},assertScope:()=>{},fetch:request,retain:vi.fn(async()=>{})};
  await expect(executeActivationWithContinuity(f.cli,{},observation,controller.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();expect(observation.retain).not.toHaveBeenCalled();expect(existsSync(join(f.root,'release-watches'))).toBe(false);
 }finally{f.close();}});
 it('pins paths and private probe/config evidence, rejecting overlapping state directories',async()=>{const f=await cliFixture();try{
  expect(readActivationManifest(f.path)).toEqual(f.cli);f.cli.review.execution.journeyDirectory=f.cli.review.execution.journalDirectory;f.cli.plan.evidenceDigest=activationReviewHash(f.cli.review);writeFileSync(f.path,JSON.stringify(f.cli));expect(()=>readActivationManifest(f.path)).toThrow('DIRECTORY_OVERLAP');
  chmodSync(f.path,0o644);expect(()=>readActivationManifest(f.path)).toThrow('PERMISSIONS');
 }finally{f.close();}});
 it('fails invalid credentials before acquiring an activation marker',async()=>{const f=await cliFixture();try{
  await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('SCHEMA_TARGET_INVALID');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 }finally{f.close();}});
 it('rejects probe-byte drift before any activation lease',async()=>{const f=await cliFixture();try{
  writeFileSync(f.cli.review.execution.probe.path,'{}');await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('FILE_CHANGED');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 }finally{f.close();}});
 it.each([false,true])('archives pre-intent cancellation without credentials (prepared=%s)',async prepared=>{const f=await cliFixture();try{
  const lease=FileDeploymentLease.acquire(f.root,f.cli.plan);if(prepared)await f.advance('prepared');lease.close();
  expect(await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000),'cancel')).toMatchObject({status:'cancelled-before-intent'});
  expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(existsSync(join(f.root,'deployment-recovery-cancelled-'+f.cli.plan.operationId))).toBe(true);
  expect(()=>FileDeploymentLease.acquire(f.root,f.cli.plan)).toThrow('ALREADY_CANCELLED');
 }finally{f.close();}});
 it('refuses cancellation after a durable activation intent',async()=>{const f=await cliFixture();try{
  const lease=FileDeploymentLease.acquire(f.root,f.cli.plan);await f.advance('prepared');await f.advance('activation-intent');lease.close();
  await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000),'cancel')).rejects.toThrow('CANCELLATION_UNSAFE');expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);
 }finally{f.close();}});
 it.each([false,true])('finishes retained finalization or reports archived history without credentials (archived=%s)',async archived=>{const f=await cliFixture();try{
  const lease=FileDeploymentLease.acquire(f.root,f.cli.plan);for(const phase of ['prepared','activation-intent','candidate-observed','complete'] as const)await f.advance(phase);
  await lease.finalize(f.journal);if(archived)await lease.release(f.journal);else lease.close();
  const expected=archived?'already-finalized':'resumed-historical-finalization';expect(await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).toMatchObject({status:expected,historical:true});expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  expect(await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).toMatchObject({status:'already-finalized'});
 }finally{f.close();}});
 it.each([false,true])('does not report a late failed continuity check as successful historical promotion (archived=%s)',async archived=>{const f=await cliFixture();try{
  const lease=FileDeploymentLease.acquire(f.root,f.cli.plan);for(const phase of ['prepared','activation-intent','candidate-observed','complete'] as const)await f.advance(phase);
  await lease.finalize(f.journal);if(archived)await lease.release(f.journal);else lease.close();
  createContinuityGate(f.cli.review.execution.proofDirectory,f.cli.plan).retain({kind:'sample',sample:{at:new Date().toISOString(),healthy:false}} as ContinuityCommandEvent);await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');expect((await f.journal.read())?.phase).toBe('complete');
 }finally{f.close();}});
 it('cannot redirect a resumed operation to a fresh journey directory',async()=>{const f=await cliFixture();try{
  const lease=FileDeploymentLease.acquire(f.root,f.cli.plan);await f.advance('prepared');lease.close();
  f.cli.review.execution.journeyDirectory=join(f.root,'replacement');mkdirSync(f.cli.review.execution.journeyDirectory,{mode:0o700});f.cli.plan.evidenceDigest=activationReviewHash(f.cli.review);
  await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000),'cancel')).rejects.toThrow('LEASE_HELD');expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);
 }finally{f.close();}});
 it('prints a fixed error from an actual native invocation without exposing input',()=>{
  const child=spawnSync(process.execPath,['scripts/release-activation-cli.ts','invalid','synthetic-private-input'],{encoding:'utf8'});expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain('RELEASE_ACTIVATION_FAILED');expect(child.stderr).not.toContain('synthetic-private-input');
 });
});

describe('complete activation command composition',()=>{
 it.each([[false,false,false,false],[true,false,false,false],[false,true,false,false],[false,false,true,false],[false,true,true,false],[false,false,false,true],[false,false,true,true],[false,false,false,true,true],[false,false,false,true,false,true],[false,false,false,true,true,true],[false,false,true,true,false,true,true]])('uses the real journals and lease (lostLogin=%s, missingFixture=%s, observed=%s, monitor=%s)',async(lostLogin,missingFixture,withObservation,monitor,historyLost,incidentRecovery,delayedObservation)=>{
  const f=await cliFixture(monitor,delayedObservation);
  const probePreflight=await import('./release-probe-preflight.ts'),preparation=await import('./release-upload-preparation.ts'),ci=await import('./release-ci.ts'),schema=await import('./release-schema.ts'),provider=await import('./cloudflare-deployment-client.ts'),inventoryModule=await import('./cloudflare-release-reader.ts');
  try{
   f.manifest.queues={staging:{id:'1'.repeat(32),name:'porchday-staging-jobs'},production:{id:'2'.repeat(32),name:'porchday-production-jobs'}};
   const bytes=JSON.stringify(f.manifest);writeFileSync(f.cli.review.execution.uploadManifest.path,bytes);f.cli.review.execution.uploadManifest.sha256=hash(bytes);
   for(const item of Object.values(f.evidence.assets))item.files['app.js']=hash('module');
   if(delayedObservation){const file=f.evidence.monitor!.baseline,value=JSON.parse(readFileSync(file.path,'utf8'));value.at-=1200000;value.body.last_checked_at=new Date(value.at).toISOString();value.body.availability.expected_minutes-=20;value.body.availability.passed_minutes-=20;value.body.availability.conservative_pass_percent=Math.round(value.body.availability.passed_minutes/value.body.availability.expected_minutes*100000)/1000;const bytes=JSON.stringify(value);writeFileSync(file.path,bytes);file.sha256=hash(bytes);}
   if(incidentRecovery){const value={version:1,mode:'unavailable-baseline',baselineVersion:f.cli.plan.baselineVersion,baselineSource:f.evidence.state.baseline.source,candidateSource:f.cli.plan.candidateSource,failure:{environment:'staging',at:Date.now(),status:503,body:{status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'}},evidence:[{path:f.testPath,sha256:hash(readFileSync(f.testPath))}]},path=join(f.root,'incident-recovery.json'),bytes=JSON.stringify(value);writeFileSync(path,bytes,{mode:0o600});f.evidence.monitor!.incidentRecovery={path,sha256:hash(bytes)};}
   f.review.publicAssets={candidate:publicAssetManifestHash(f.evidence.assets.candidate),baseline:publicAssetManifestHash(f.evidence.assets.baseline)};f.save();if(!monitor)f.cli.plan.assetManifests={...f.review.publicAssets};
   const inventory=structuredClone(f.proof.inventory);let observed={version:id(1),deploymentId:id(5),operationId:null as string|null},revoked=false,logins=0;
   vi.spyOn(preparation,'verifyUploadTooling').mockImplementation(async(_workspace,source)=>({source}));vi.spyOn(ci,'verifyReleaseCi').mockImplementation(async o=>({source:o.source,repository:'porchday/porchday',runs:[]}));vi.spyOn(schema,'captureReleaseSchema').mockImplementation(async()=>structuredClone(f.manifest.evidence.schema));
   const preflight=vi.spyOn(probePreflight,'verifyReleaseProbeFixture').mockImplementation(async()=>{if(missingFixture)throw Error('RELEASE_PROBE_FIXTURE_INVALID');});
   vi.spyOn(inventoryModule.CloudflareReleaseReader.prototype,'snapshot').mockImplementation(async()=>structuredClone(inventory) as any);
   vi.spyOn(provider.CloudflareDeploymentClient.prototype,'observe').mockImplementation(async()=>({...observed}));
   const deploy=vi.spyOn(provider.CloudflareDeploymentClient.prototype,'deploy').mockImplementation(async(version,operationId)=>{inventory.workers[f.key].active=version;inventory.workers[f.key].resources=f.proof.candidate.resources;observed={version,operationId,deploymentId:id(7)};throw Error('LOST_PROVIDER_REPLY');});
   const continuityEvents:any[]=[];let candidateStatusReads=0;
   const request=vi.fn(async(input:any,init:any)=>{const path=new URL(String(input)).pathname;
    if(init?.headers?.Cookie==='continuity-denied')return Response.json({}, {status:401});
    if(init?.headers?.Cookie==='continuity-allowed'&&path.endsWith('/me'))return Response.json({id:id(91)},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('/health'))return Response.json({status:'ok',issues:[]});
    if(path.endsWith('/get-session'))return Response.json(null);
    if(path.endsWith('/status')){if(incidentRecovery&&observed.version===id(1))return Response.json({status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'},{status:503});const body=monitor?f.monitorBody():{last_checked_at:new Date().toISOString()};if(delayedObservation&&observed.version===id(2)&&++candidateStatusReads===1){(body as any).last_checked_at=new Date(Date.now()-600000).toISOString();(body as any).status='unknown';(body as any).metrics_monitoring='unavailable';}if(historyLost&&observed.version===id(2))(body as any).availability.failed_minutes=0;return Response.json(body);}
    if(path.endsWith('/sign-in/email')){logins++;if(lostLogin)throw Error('LOST_LOGIN_REPLY');return Response.json({user:{id:id(90)}},{headers:{'set-cookie':'better-auth.session_token=synthetic-token; HttpOnly'}});}
    if(path.endsWith('/sign-out')){revoked=true;return Response.json({success:true});}
    if(path.endsWith('/me'))return revoked?Response.json({}, {status:401}):Response.json({id:id(90)},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('.js'))return new Response('module',{headers:{'content-type':'text/javascript'}});
    throw Error('UNEXPECTED_NETWORK_REQUEST');
   });vi.stubGlobal('fetch',request);
   const databaseUrl=new URL('postgres://host.pg.psdb.cloud:5432/database?sslmode=verify-full');databaseUrl.username='test.synthetic';databaseUrl.password='synthetic';
   const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'t'.repeat(32),PORCHDAY_STAGING_DATABASE_MIGRATION_URL:databaseUrl.href};
   const observedOptions={target:{environment:'staging' as const,memberId:id(91),cookie:'continuity-allowed',deniedCookie:'continuity-denied',healthToken:'h'.repeat(32)},assertScope:()=>{},intervalMs:1000,retain:async(event:any)=>{continuityEvents.push(event);}};
   const activate=monitor?executeMonitorActivationManifest:executeActivationManifest,observe=monitor?executeMonitorActivationWithContinuity:executeActivationWithContinuity;
   const execute=()=>withObservation?observe(f.cli,env,observedOptions,AbortSignal.timeout(10000)):activate(f.cli,env,AbortSignal.timeout(10000));
   if(missingFixture){
    await expect(execute()).rejects.toThrow(withObservation?'CONTINUITY_COMMAND_UNVERIFIED':'RELEASE_PROBE_FIXTURE_INVALID');
    expect(preflight).toHaveBeenCalledTimes(1);expect(deploy).not.toHaveBeenCalled();expect(logins).toBe(0);if(withObservation)expect(continuityEvents.filter(e=>e.kind==='sample')).toHaveLength(3);else expect(request).not.toHaveBeenCalled();
    expect(observed.version).toBe(id(1));expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).stagingVersion).toBe(id(1));
    expect(await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000),'cancel')).toMatchObject({status:'cancelled-before-intent'});expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);return;
   }
   const result=await execute();expect(result.status).toBe(withObservation?'complete':lostLogin||historyLost?'attention-required':'finalized');
   if(withObservation){expect(result).toMatchObject({postCommandSamples:2,failedSamples:0});const count=request.mock.calls.length;await expect(execute()).rejects.toThrow('REQUIRES_RECONCILIATION');expect(request.mock.calls.length).toBe(count);}expect(deploy).toHaveBeenCalledTimes(1);expect(logins).toBe(incidentRecovery&&historyLost?0:1);
   if(lostLogin||historyLost){expect(await activate(f.cli,env,AbortSignal.timeout(10000))).toMatchObject({status:'attention-required',outcome:'verification-unavailable'});expect(logins).toBe(incidentRecovery&&historyLost?0:1);expect(preflight).toHaveBeenCalledTimes(1);expect(deploy).toHaveBeenCalledTimes(1);expect(existsSync(join(f.root,'deployment-lock'))).toBe(true);}
   else{const count=request.mock.calls.length;expect(await activate(f.cli,{},AbortSignal.timeout(5000))).toMatchObject({status:'already-finalized'});expect(request.mock.calls.length).toBe(count);expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8'))).toMatchObject(monitor?{stagingVersion:id(1),monitorVersions:{staging:id(2)},monitorSources:{staging:'a'.repeat(40)}}:{stagingVersion:id(2),stagingAssetsSource:'a'.repeat(40)});if(monitor)expect(readdirSync(f.cli.review.execution.proofDirectory).map(n=>JSON.parse(readFileSync(join(f.cli.review.execution.proofDirectory,n),'utf8'))).filter(x=>x.kind==='monitor-history').length).toBeGreaterThanOrEqual(incidentRecovery?2:3);if(incidentRecovery)expect(readdirSync(f.cli.review.execution.proofDirectory).map(n=>JSON.parse(readFileSync(join(f.cli.review.execution.proofDirectory,n),'utf8'))).filter(x=>x.kind==='monitor-unavailable-baseline')).toHaveLength(1);}
  }finally{vi.restoreAllMocks();vi.unstubAllGlobals();f.close();}
 });
});

it('retains a sanitized private failure code on a native command failure',async()=>{const f=await cliFixture();try{
 const child=spawnSync(process.execPath,['scripts/release-activation-cli.ts','activate',f.path],{encoding:'utf8',env:{...process.env,PORCHDAY_MONITOR_GH_PATH:'/nonexistent/porchday-test-gh',PORCHDAY_STAGING_DATABASE_MIGRATION_URL:''}});
 expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain('RELEASE_ACTIVATION_FAILED');
 expect(child.stderr).toContain('RELEASE_OWNER_NOTIFICATION_PENDING');const all=readdirSync(f.cli.review.execution.proofDirectory);expect(all.filter(n=>n.startsWith('attention-'))).toHaveLength(1);const files=all.filter(n=>n.startsWith('failure-'));expect(files).toHaveLength(1);const record=JSON.parse(readFileSync(join(f.cli.review.execution.proofDirectory,files[0]),'utf8'));expect(record).toMatchObject({operationId:f.cli.plan.operationId,code:'RELEASE_SCHEMA_TARGET_INVALID'});expect(JSON.stringify(record)).not.toContain('p'.repeat(32));expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
}finally{f.close();}});

it('requires monitor-specific review before credentials, leases or provider writes',async()=>{const f=await cliFixture(true);try{
 delete f.cli.review.monitor;f.cli.plan.evidenceDigest=activationReviewHash(f.cli.review);
 await expect(executeMonitorActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('MONITOR_EVIDENCE_REQUIRED');
 expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
}finally{f.close();}});
it('routes the explicit native monitor action through monitor verification and fixed failure reporting',async()=>{const f=await cliFixture(true);try{
 const child=spawnSync(process.execPath,['scripts/release-activation-cli.ts','activate-monitor',f.path],{encoding:'utf8',env:{...process.env,PORCHDAY_MONITOR_GH_PATH:'/nonexistent/porchday-test-gh',PORCHDAY_STAGING_DATABASE_MIGRATION_URL:''}});
 expect(child.status).toBe(1);expect(child.stderr).toContain('RELEASE_ACTIVATION_FAILED');expect(child.stdout).toBe('');
 const failures=readdirSync(f.cli.review.execution.proofDirectory).filter(n=>n.startsWith('failure-'));
 expect(failures).toHaveLength(1);expect(JSON.parse(readFileSync(join(f.cli.review.execution.proofDirectory,failures[0]),'utf8')).code).toBe('RELEASE_SCHEMA_TARGET_INVALID');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
}finally{f.close();}});

describe('observed activation continuity interlock',()=>{
 it.each(['prepared','candidate','rollback','terminal'])('preserves failures at %s with the real entry point, lease and journals',async boundary=>{
  const f=await cliFixture();
  const probePreflight=await import('./release-probe-preflight.ts'),preparation=await import('./release-upload-preparation.ts'),ci=await import('./release-ci.ts'),schema=await import('./release-schema.ts'),provider=await import('./cloudflare-deployment-client.ts'),inventoryModule=await import('./cloudflare-release-reader.ts');
  try{
   f.manifest.queues={staging:{id:'1'.repeat(32),name:'porchday-staging-jobs'},production:{id:'2'.repeat(32),name:'porchday-production-jobs'}};
   const bytes=JSON.stringify(f.manifest);writeFileSync(f.cli.review.execution.uploadManifest.path,bytes);f.cli.review.execution.uploadManifest.sha256=hash(bytes);
   for(const item of Object.values(f.evidence.assets))item.files['app.js']=hash('module');
   f.review.publicAssets={candidate:publicAssetManifestHash(f.evidence.assets.candidate),baseline:publicAssetManifestHash(f.evidence.assets.baseline)};f.save();f.cli.plan.assetManifests={...f.review.publicAssets};
   const inventory=structuredClone(f.proof.inventory);let observed={version:id(1),deploymentId:id(5),operationId:null as string|null},revoked=false;
   vi.spyOn(preparation,'verifyUploadTooling').mockImplementation(async(_workspace,source)=>({source}));vi.spyOn(ci,'verifyReleaseCi').mockImplementation(async o=>({source:o.source,repository:'porchday/porchday',runs:[]}));vi.spyOn(schema,'captureReleaseSchema').mockImplementation(async()=>structuredClone(f.manifest.evidence.schema));
   vi.spyOn(probePreflight,'verifyReleaseProbeFixture').mockResolvedValue(undefined);
   vi.spyOn(inventoryModule.CloudflareReleaseReader.prototype,'snapshot').mockImplementation(async()=>structuredClone(inventory) as any);
   vi.spyOn(provider.CloudflareDeploymentClient.prototype,'observe').mockImplementation(async()=>({...observed}));
   const deploy=vi.spyOn(provider.CloudflareDeploymentClient.prototype,'deploy').mockImplementation(async(version,operationId)=>{inventory.workers[f.key].active=version;inventory.workers[f.key].resources=version===id(2)?f.proof.candidate.resources:f.manifest.evidence.resources;observed={version,operationId,deploymentId:id(version===id(2)?7:8)};throw Error('LOST_PROVIDER_REPLY');});
   const continuityEvents:any[]=[];
   const request=vi.fn(async(input:any,init:any)=>{const path=new URL(String(input)).pathname;
    if(init?.headers?.Cookie==='continuity-denied')return Response.json({}, {status:401});
    if(init?.headers?.Cookie==='continuity-allowed'&&path.endsWith('/me'))return Response.json({id:id(91)},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('/health'))return Response.json({status:'ok',issues:[]});
    if(path.endsWith('/get-session'))return Response.json(null);
    if(path.endsWith('/status'))return Response.json({last_checked_at:new Date().toISOString()});
    if(path.endsWith('/sign-in/email')){revoked=false;return Response.json({user:{id:id(90)}},{headers:{'set-cookie':'better-auth.session_token=synthetic-token; HttpOnly'}});}
    if(path.endsWith('/sign-out')){revoked=true;return Response.json({success:true});}
    if(path.endsWith('/me'))return revoked?Response.json({}, {status:401}):Response.json({id:id(90)},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'no-store'}});
    if(path.endsWith('.js'))return new Response('module',{headers:{'content-type':'text/javascript'}});
    throw Error('UNEXPECTED_NETWORK_REQUEST');
   });vi.stubGlobal('fetch',request);
   const databaseUrl=new URL('postgres://host.pg.psdb.cloud:5432/database?sslmode=verify-full');databaseUrl.username='test.synthetic';databaseUrl.password='synthetic';
   const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'t'.repeat(32),PORCHDAY_STAGING_DATABASE_MIGRATION_URL:databaseUrl.href};
   const observedOptions={target:{environment:'staging' as const,memberId:id(91),cookie:'continuity-allowed',deniedCookie:'continuity-denied',healthToken:'h'.repeat(32)},assertScope:()=>{},intervalMs:1000,retain:async(event:any)=>{continuityEvents.push(event);}};

   let failed=false,release!:()=>void;const failedSample=new Promise<void>(r=>{release=r;});
   const normal=request.getMockImplementation()!;
   if(boundary==='prepared')vi.spyOn(preparation,'verifyUploadTooling').mockImplementation(async(_w,source)=>{await failedSample;return{source};});
   if(boundary==='candidate'||boundary==='rollback')request.mockImplementation(async(input,init)=>{
    if(new URL(String(input)).pathname.endsWith('/health')){
     if(observed.version===id(2))await failedSample;
     else if(boundary==='rollback'&&deploy.mock.calls.length===2)return Response.json({status:'unavailable',issues:['synthetic']},{status:503});
    }
    return normal(input,init);
   });
   const observation={...observedOptions,fetch:async(input:any,init:any)=>{
    if(new URL(String(input)).pathname.endsWith('/health')&&!failed){
     const phase=(await f.journal.read())?.phase;
     if(phase===(boundary==='prepared'?'prepared':boundary==='terminal'?'complete':'candidate-observed')){
      failed=true;return Response.json({status:'unavailable',issues:['synthetic']},{status:503});
     }
    }
    return normal(input,init);
   },retain:async(event:any)=>{continuityEvents.push(event);if(event.kind==='sample'&&!event.sample.healthy)release();}};
   await expect(executeActivationWithContinuity(f.cli,env,observation,AbortSignal.timeout(12000))).rejects.toThrow('CONTINUITY_SAMPLES_FAILED');
   expect(failed).toBe(true);expect(readdirSync(f.cli.review.execution.proofDirectory).some(n=>n.startsWith('continuity-failure-'))).toBe(true);
   expect(readdirSync(f.cli.review.execution.proofDirectory).filter(n=>n.startsWith('attention-'))).toHaveLength(1);
   expect(deploy).toHaveBeenCalledTimes(boundary==='prepared'?0:boundary==='terminal'?1:2);
   const state=await f.journal.read();expect(state?.phase).toBe(boundary==='prepared'?'prepared':boundary==='terminal'?'complete':boundary==='rollback'?'rollback-intent':'rolled-back');
   expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).stagingVersion).toBe(boundary==='terminal'?id(2):id(1));
   if(boundary==='prepared'){
    await expect(executeActivationManifest(f.cli,env,AbortSignal.timeout(5000))).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');
    await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000),'cancel');
   }else if(boundary==='terminal'){
    const calls=request.mock.calls.length;await expect(executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');expect(request.mock.calls.length).toBe(calls);
   }else if(boundary==='candidate')expect(await executeActivationManifest(f.cli,{},AbortSignal.timeout(5000))).toMatchObject({status:'already-finalized'});
   else expect(await executeActivationManifest(f.cli,env,AbortSignal.timeout(5000))).toMatchObject({status:'attention-required'});
   expect(deploy).toHaveBeenCalledTimes(boundary==='prepared'?0:boundary==='terminal'?1:2);
  }finally{vi.restoreAllMocks();vi.unstubAllGlobals();f.close();}
 },15000);
});
