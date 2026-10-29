import {finalizePreparedActivation} from './release-activation-finalize.ts';
import {activationReviewHash,verifyActivationReview,createReviewedActivationPorts,compatibilityChecks,type ActivationReviewEvidence,type CompatibilityReview} from './release-activation-review.ts';
import {publicAssetManifestHash} from './release-assets-verify.ts';
import {describe,it,expect,vi} from 'vitest';
import {createActivationStateVerifier,createPreparedActivationPorts} from './release-activation-state.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
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
async function fixture(options:{complete?:boolean;frontend?:boolean;production?:boolean;mutate?:(proof:any)=>void}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-activation-evidence-'))),source='a'.repeat(40),environment=options.production?'production':'staging',worker='porchday-'+environment+(options.frontend?'-edge':''),key=environment+(options.frontend?'-edge':''),entry=options.frontend?'edge.js':'index.js';
 const canonical=JSON.stringify({stagingVersion:id(1),stagingRuntimeSource:'b'.repeat(40),compatibleRollbackVersions:{staging:id(1)},edgeRouting:{stagingEnabled:!!options.frontend,stagingFrontendVersion:id(1),stagingFrontendSource:'b'.repeat(40)}});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
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

async function reviewFixture(production=false){
 const f=await fixture({production}),upload=readCompletedUpload(f.manifest,f.proofPath),path=join(f.root,'compatibility.json'),testPath=join(f.root,'test-result.json');
 const result=JSON.stringify({synthetic:true,passed:true});writeFileSync(testPath,result,{mode:0o600});
 const assets={candidate:{source:'a'.repeat(40),files:{'app.js':'1'.repeat(64)}},baseline:{source:'b'.repeat(40),files:{'app.js':'2'.repeat(64)}}};
 const review:CompatibilityReview={version:1,worker:f.deployment.worker,candidate:{source:'a'.repeat(40),version:id(2)},baseline:{source:'b'.repeat(40),version:id(1)},schema:f.manifest.evidence.schema,publicAssets:{candidate:publicAssetManifestHash(assets.candidate),baseline:publicAssetManifestHash(assets.baseline)},checks:Object.fromEntries(compatibilityChecks.map(name=>[name,{status:'passed',basis:'Synthetic fixture for '+name,evidence:[{path:testPath,sha256:hash(result)}]}])) as CompatibilityReview['checks']};
 const evidence:ActivationReviewEvidence={version:1,state:{version:1,uploadPlanHash:upload.uploadPlanHash,uploadProofSha256:upload.proofSha256,tooling:{source:'d'.repeat(40),ci:f.manifest.evidence.ci},baseline:{source:'b'.repeat(40),ci:f.manifest.evidence.ci}},compatibility:{path,sha256:''},assets};
 const plan={...f.deployment};
 function save(){const bytes=JSON.stringify(review);writeFileSync(path,bytes,{mode:0o600});evidence.compatibility.sha256=hash(bytes);plan.evidenceDigest=activationReviewHash(evidence);}
 save();return{...f,review,evidence,plan,save,testPath,verify:()=>verifyActivationReview(plan,f.manifest,f.proofPath,evidence)};
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
 it.each(['unresolved','assets','identity','inventory','journal','review'])('retains the lease and canonical baseline on %s failure',async kind=>{const f=await finalizationFixture();try{
  if(kind==='unresolved')f.journal.read.mockResolvedValue({...f.state,phase:'candidate-observed'});
  if(kind==='assets')f.request.mockResolvedValue(new Response('wrong',{headers:{'content-type':'text/javascript'}}));
  if(kind==='identity')f.client.observe.mockResolvedValue({version:id(2),deploymentId:id(9),operationId:f.plan.operationId});
  if(kind==='inventory')f.reader.snapshot.mockImplementation(async()=>{const x=structuredClone(f.proof.inventory);x.workers.production.latest=id(9);return x;});
  if(kind==='journal')f.journal.read.mockResolvedValueOnce(f.state).mockResolvedValue({...f.state,revision:99});
  if(kind==='review')writeFileSync(f.testPath,'changed');
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
