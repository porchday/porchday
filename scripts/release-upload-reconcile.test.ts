import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {FileUploadLease,type UploadPlan} from './release-upload-lease.ts';
import {releaseSettings} from './cloudflare-release-reader.ts';
import {createUploadReconciler,uploadReconciliationEvidenceHash,type UploadReconciliationEvidence} from './release-upload-reconcile.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const signal=()=>AbortSignal.timeout(10000);
function fixture(application:'api'|'monitor'='api'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-reconcile-'))),artifactDirectory=join(root,'artifacts'),proofDirectory=join(root,'proofs');
 mkdirSync(artifactDirectory,{mode:0o700});mkdirSync(proofDirectory,{mode:0o700});mkdirSync(join(root,'apps/'+application+'/src'),{recursive:true});writeFileSync(join(root,'apps/'+application+'/src/index.ts'),'reviewed source');
 const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['config','user.name','Synthetic Test']);git(['config','user.email','synthetic@example.invalid']);git(['add','apps']);git(['commit','-qm','fixture']);const source=git(['rev-parse','HEAD']);
 const modules={'index.js':Buffer.from('synthetic reviewed executable'),'index.js.map':Buffer.from(JSON.stringify({version:3,sources:['src/index.ts'],sourcesContent:['reviewed source'],names:[],mappings:'AAAA'}))};
 for(const [name,bytes] of Object.entries(modules))writeFileSync(join(artifactDirectory,name),bytes,{mode:0o600});
 const canonical=JSON.stringify({stagingVersion:id(3),stagingRuntimeSource:source});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const settings=releaseSettings({bindings:[]}),resources={script:{etag:'baseline',handlers:['fetch']},script_runtime:{compatibility_date:'2026-10-24'},bindings:[]};
 const before={workers:Object.fromEntries(['staging','staging-edge','production','production-edge','monitor-staging','monitor-production'].map(key=>[key,{active:id(3),latest:id(4),settings,resources}])),domains:[],queues:{},schedules:{}};
 const after=structuredClone(before);after.workers[application==='monitor'?'monitor-staging':'staging'].latest=id(2);
 const schema={version:1 as const,migrations:['000_initial.sql'],functionsSha256:'a'.repeat(64),columnsSha256:'b'.repeat(64)};
 const evidence:UploadReconciliationEvidence={version:1,worker:application==='monitor'?'porchday-monitor-staging':'porchday-staging',source,before,settings,resources,databaseBranchId:'synthetic',schema,ci:{verify:{runId:1,attempt:1,workflowSha256:'a'.repeat(64)},history:{runId:2,attempt:1,workflowSha256:'b'.repeat(64)}},artifacts:{directory:artifactDirectory,entry:'index.js',hashes:Object.fromEntries(Object.entries(modules).map(([name,bytes])=>[name,hash(bytes)])),sourcePaths:['apps/'+application+'/src/index.ts']}};
 const plan:UploadPlan={operationId:id(1),worker:evidence.worker,source,canonicalSha256:hash(canonical),evidenceDigest:uploadReconciliationEvidenceHash(evidence)},lease=FileUploadLease.acquire(root,plan);
 const candidate={version:id(2),resources:{...resources,script:{...resources.script,etag:'candidate'}}};
 const reader={uploadedVersion:vi.fn(async()=>structuredClone(candidate)),snapshot:vi.fn(async()=>structuredClone(after)),script:vi.fn(async()=>structuredClone(modules))};
 const checks={ci:vi.fn(async()=>({source,repository:'porchday/porchday',runs:[]})),schema:vi.fn(async()=>structuredClone(schema))};
 const options={workspace:root,proofDirectory,evidence,lease,reader,database:{connection:'synthetic-unused',branchId:'synthetic'},checks};
 const proofPath=join(proofDirectory,'upload-proof-'+plan.operationId+'.json');
 return{root,canonical,plan,lease,options,reader,checks,after,candidate,proofPath};
}
describe('composed inactive-upload reconciliation',()=>{
 it.each(['api','monitor'] as const)('verifies every %s upload gate, records proof, resumes and preserves active state',async application=>{
  const f=fixture(application);try{
   await f.lease.dispatchOnce(async()=>{},async()=>{},signal());const reconcile=createUploadReconciler(f.options);
   await f.lease.reconcile(reconcile,signal());await f.lease.reconcile(reconcile,signal());
   const bytes=readFileSync(f.proofPath),proof=JSON.parse(bytes.toString());expect(proof.provenance.source).toBe(f.plan.source);expect(proof.artifacts.hashes['index.js']).toBe(f.options.evidence.artifacts.hashes['index.js']);
   expect(f.checks.ci).toHaveBeenCalledTimes(2);expect(f.checks.schema).toHaveBeenCalledTimes(4);expect(f.reader.uploadedVersion).toHaveBeenCalledTimes(4);expect(f.reader.snapshot).toHaveBeenCalledTimes(4);
   expect(f.lease.release().evidenceDigest).toBe(hash(bytes));expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
  }finally{f.lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it.each((['api','monitor'] as const).flatMap(application=>(['ci','schema','resources','artifact','inventory','identity','canonical'] as const).map(kind=>({application,kind}))))('retains unresolved $application intent and writes no success proof on $kind failure',async({application,kind})=>{
  const f=fixture(application);try{
   if(kind==='ci')f.checks.ci.mockRejectedValue(Error('CI failed'));
   if(kind==='schema')f.checks.schema.mockResolvedValue({...f.options.evidence.schema,columnsSha256:'f'.repeat(64)});
   if(kind==='resources')f.reader.uploadedVersion.mockResolvedValue({...f.candidate,resources:{...f.candidate.resources,script_runtime:{compatibility_date:'other'}}});
   if(kind==='artifact')f.reader.script.mockResolvedValue({'index.js':Buffer.from('wrong'),'index.js.map':Buffer.from('{}')});
   if(kind==='inventory'){const changed=structuredClone(f.after);changed.workers.production.active=id(9);f.reader.snapshot.mockResolvedValueOnce(f.after).mockResolvedValue(changed);}
   if(kind==='identity')f.reader.uploadedVersion.mockResolvedValueOnce(f.candidate).mockResolvedValue({...f.candidate,version:id(9)});
   if(kind==='canonical')f.reader.script.mockImplementation(async()=>{writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical+' ');return{'index.js':Buffer.from('wrong'),'index.js.map':Buffer.from('{}')};});
   await f.lease.dispatchOnce(async()=>{},async()=>{},signal());await expect(f.lease.reconcile(createUploadReconciler(f.options),signal())).rejects.toThrow();
   expect(existsSync(f.proofPath)).toBe(false);expect(existsSync(join(f.root,'deployment-lock/upload-intent.json'))).toBe(true);expect(existsSync(join(f.root,'deployment-lock/upload-verified.json'))).toBe(false);
  }finally{f.lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('binds evidence and the callback plan to the acquired lease',async()=>{
  const f=fixture();try{
   const reconcile=createUploadReconciler(f.options);await expect(reconcile({...f.plan,operationId:id(9)},signal())).rejects.toThrow('UPLOAD_PLAN_CHANGED');
   const evidence=structuredClone(f.options.evidence);evidence.artifacts.sourcePaths=[];
   await expect(createUploadReconciler({...f.options,evidence})(f.plan,signal())).rejects.toThrow('EVIDENCE_PLAN_CHANGED');expect(f.checks.ci).not.toHaveBeenCalled();
   expect(()=>createUploadReconciler({...f.options,database:{...f.options.database,branchId:'different'}})).toThrow('EVIDENCE_INVALID');
  }finally{f.lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
});
