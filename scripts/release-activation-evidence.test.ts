import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileUploadLease,uploadPlanHash} from './release-upload-lease.ts';
import {comparableReleaseResources,uploadReconciliationEvidenceHash} from './release-upload-reconcile.ts';
import {releaseSettings} from './cloudflare-release-reader.ts';
import {readCompletedUpload,assertActivationInventory} from './release-activation-evidence.ts';
import type {UploadManifest} from './release-upload-cli.ts';
import type {DeploymentPlan} from './deployment-recovery.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
async function fixture(options:{complete?:boolean;frontend?:boolean;mutate?:(proof:any)=>void}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-activation-evidence-'))),source='a'.repeat(40),worker=options.frontend?'porchday-staging-edge':'porchday-staging',key=options.frontend?'staging-edge':'staging',entry=options.frontend?'edge.js':'index.js';
 const canonical='{}';writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
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
 const deployment:DeploymentPlan={operationId:id(4),worker,candidateVersion:id(2),candidateSource:source,baselineVersion:id(1),baselineDeploymentId:id(5),compatibleRollbackVersions:[id(1)],evidenceDigest:'4'.repeat(64),...(options.frontend?{backendVersion:id(1),backendReaderFloor:id(6)}:{})};
 return{root,manifest,proofPath,proof,deployment,key,close:()=>{lease.close();rmSync(root,{recursive:true,force:true});}};
}
describe('verified inactive-upload handoff',()=>{
 it('reads a real archived lease without provider calls or a new lock',async()=>{const f=await fixture();try{const upload=readCompletedUpload(f.manifest,f.proofPath);expect(upload.candidateVersion).toBe(id(2));expect(upload.proofSha256).toBe(hash(readFileSync(f.proofPath)));expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe('{}');f.manifest.evidence.source='f'.repeat(40);expect(upload.source).toBe('a'.repeat(40));}finally{f.close();}});
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
