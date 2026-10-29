import {describe,it,expect,vi,beforeEach} from 'vitest';
import {mkdtempSync,writeFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileUploadLease} from './release-upload-lease.ts';
import {uploadReconciliationEvidenceHash} from './release-upload-reconcile.ts';
import {runPreparedUpload,type PreparedUploadEvidence} from './release-upload.ts';
const gates=vi.hoisted(()=>({prepare:vi.fn(),ci:vi.fn(),schema:vi.fn(),provenance:vi.fn(),send:vi.fn(),reconcile:vi.fn(),transport:vi.fn()}));
vi.mock('./release-upload-preparation.ts',async original=>({...await original<typeof import('./release-upload-preparation.ts')>(),verifyUploadPreparation:gates.prepare}));
vi.mock('./release-ci.ts',()=>({verifyReleaseCi:gates.ci}));
vi.mock('./release-schema.ts',async original=>({...await original<typeof import('./release-schema.ts')>(),captureReleaseSchema:gates.schema}));
vi.mock('./release-worker-artifacts.ts',async original=>({...await original<typeof import('./release-worker-artifacts.ts')>(),verifyWorkerSourceProvenance:gates.provenance}));
vi.mock('./release-upload-process.ts',()=>({createWranglerUploadProcess:(options:unknown)=>{gates.transport(options);return gates.send;}}));
vi.mock('./release-upload-reconcile.ts',async original=>({...await original<typeof import('./release-upload-reconcile.ts')>(),createUploadReconciler:()=>gates.reconcile}));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),operationId='11111111-1111-1111-1111-111111111111',version='22222222-2222-2222-2222-222222222222';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-composed-upload-'))),source='a'.repeat(40),accountId='b'.repeat(32),canonical='{}';writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});writeFileSync(join(root,'index.js.map'),'{}',{mode:0o600});
 const configPath=join(root,'config.json'),config=JSON.stringify({name:'porchday-staging',account_id:accountId});writeFileSync(configPath,config,{mode:0o600});
 const schema={version:1 as const,migrations:['000_initial.sql'],functionsSha256:'a'.repeat(64),columnsSha256:'b'.repeat(64)},ci={verify:{runId:1,attempt:1,workflowSha256:'a'.repeat(64)},history:{runId:2,attempt:1,workflowSha256:'b'.repeat(64)}},hashes={'index.js':'c'.repeat(64),'index.js.map':'d'.repeat(64)};
 const evidence:PreparedUploadEvidence={version:1,worker:'porchday-staging',source,before:{baseline:true},settings:{},resources:{script:{},script_runtime:{},bindings:[]},databaseBranchId:'synthetic',schema,ci,artifacts:{directory:root,entry:'index.js',hashes,sourcePaths:['apps/api/src/index.ts']},preparation:{configPath,configSha256:hash(config),inputs:{bundle:{directory:root,entry:'index.js',files:hashes},assets:null},wrangler:{} as PreparedUploadEvidence['preparation']['wrangler'],toolingSource:source,toolingCi:ci,assetSources:[]}};
 const plan={operationId,worker:evidence.worker,source,canonicalSha256:hash(canonical),evidenceDigest:uploadReconciliationEvidenceHash(evidence)},lease=FileUploadLease.acquire(root,plan);
 const reader={snapshot:vi.fn(async()=>({baseline:true})),uploadedVersion:vi.fn(),script:vi.fn()};
 gates.schema.mockResolvedValue(schema);gates.reconcile.mockResolvedValue({version,evidenceDigest:'e'.repeat(64)});
 const options={workspace:root,proofDirectory:root,evidence,lease,reader,database:{connection:'synthetic',branchId:'synthetic'},accountId,apiToken:'synthetic',privateLogDirectory:root};
 return{root,plan,options,lease,close:()=>{lease.close();rmSync(root,{recursive:true,force:true});}};
}
beforeEach(()=>{for(const fn of Object.values(gates))fn.mockReset();});
describe('prepared upload orchestration with real durable lease',()=>{
 it('authorizes, dispatches and reconciles exactly once before archiving',async()=>{const f=fixture();try{const result=await runPreparedUpload(f.options,AbortSignal.timeout(5000));expect(result.verified.version).toBe(version);expect(gates.prepare).toHaveBeenCalledOnce();expect(gates.send).toHaveBeenCalledWith(operationId,expect.any(AbortSignal));expect(gates.reconcile).toHaveBeenCalledOnce();expect(gates.transport.mock.calls[0][0].inputs).toEqual(f.options.evidence.preparation.inputs);expect(FileUploadLease.completed(f.root,f.plan)?.version).toBe(version);}finally{f.close();}});
 it.each(['preparation','ci','schema','baseline'])('never dispatches after failed %s authorization',async kind=>{const f=fixture();try{if(kind==='preparation')gates.prepare.mockRejectedValue(Error('failed'));if(kind==='ci')gates.ci.mockRejectedValue(Error('failed'));if(kind==='schema')gates.schema.mockResolvedValue({...f.options.evidence.schema,functionsSha256:'f'.repeat(64)});if(kind==='baseline')f.options.reader.snapshot.mockResolvedValue({baseline:false});await expect(runPreparedUpload(f.options,AbortSignal.timeout(5000))).rejects.toThrow();expect(gates.send).not.toHaveBeenCalled();expect(existsSync(join(f.root,'deployment-lock/upload-intent.json'))).toBe(false);}finally{f.close();}});
 it('resumes an uncertain upload only through reconciliation, without reauthorization or another send',async()=>{const f=fixture();try{gates.send.mockRejectedValue(Error('lost response'));gates.reconcile.mockRejectedValueOnce(Error('read unavailable'));await expect(runPreparedUpload(f.options,AbortSignal.timeout(5000))).rejects.toThrow('read unavailable');const result=await runPreparedUpload(f.options,AbortSignal.timeout(5000));expect(result.dispatch).toBe('reconcile');expect(gates.send).toHaveBeenCalledOnce();expect(gates.prepare).toHaveBeenCalledOnce();expect(gates.reconcile).toHaveBeenCalledTimes(2);}finally{f.close();}});
 it('rejects changed evidence before dispatch',async()=>{const f=fixture();try{f.options.evidence.preparation.toolingSource='f'.repeat(40);await expect(runPreparedUpload(f.options,AbortSignal.timeout(5000))).rejects.toThrow('EVIDENCE_PLAN_CHANGED');expect(gates.send).not.toHaveBeenCalled();expect(gates.prepare).not.toHaveBeenCalled();}finally{f.close();}});
});
