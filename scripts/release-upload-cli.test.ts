import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readUploadManifest,executeUploadManifest,type UploadManifest} from './release-upload-cli.ts';
import {FileUploadLease} from './release-upload-lease.ts';
import {uploadReconciliationEvidenceHash,type UploadReconciliationEvidence} from './release-upload-reconcile.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-upload-cli-'))),canonical='{}',source='a'.repeat(40);
 writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const evidence={worker:'porchday-staging',source,preparation:{}} as UploadManifest['evidence'];
 const plan={operationId:'11111111-1111-1111-1111-111111111111',worker:evidence.worker,source,canonicalSha256:hash(canonical),evidenceDigest:uploadReconciliationEvidenceHash(evidence as UploadReconciliationEvidence)};
 const manifest:UploadManifest={version:1,root,workspace:root,proofDirectory:root,privateLogDirectory:root,plan,evidence,queues:{staging:{id:'b'.repeat(32),name:'porchday-staging-jobs'},production:{id:'c'.repeat(32),name:'porchday-production-jobs'}}};
 const path=join(root,'manifest.json');writeFileSync(path,JSON.stringify(manifest),{mode:0o600});
 return{root,path,manifest,close:()=>rmSync(root,{recursive:true,force:true})};
}
describe('operator upload command',()=>{
 it('reads only private, unchanged manifest evidence',()=>{const f=fixture();try{expect(readUploadManifest(f.path)).toEqual(f.manifest);const changed=structuredClone(f.manifest);changed.evidence.source='f'.repeat(40);writeFileSync(f.path,JSON.stringify(changed));expect(()=>readUploadManifest(f.path)).toThrow('EVIDENCE_CHANGED');chmodSync(f.path,0o644);expect(()=>readUploadManifest(f.path)).toThrow('MANIFEST_INVALID');}finally{f.close();}});
 it('cancels an owned pre-dispatch preparation without credentials or deleting its evidence',async()=>{const f=fixture();try{const lease=FileUploadLease.acquire(f.root,f.manifest.plan);lease.close();expect(await executeUploadManifest(readUploadManifest(f.path),'cancel',{},AbortSignal.timeout(5000))).toMatchObject({status:'cancelled-before-dispatch'});expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(existsSync(join(f.root,'release-upload-cancelled-'+f.manifest.plan.operationId+'/owner.json'))).toBe(true);}finally{f.close();}});
 it('refuses to cancel an uncertain upload',async()=>{const f=fixture();try{const lease=FileUploadLease.acquire(f.root,f.manifest.plan);await lease.dispatchOnce(async()=>{},async()=>{throw Error('lost response');},AbortSignal.timeout(5000));lease.close();await expect(executeUploadManifest(f.manifest,'cancel',{},AbortSignal.timeout(5000))).rejects.toThrow('CANCELLATION_UNSAFE');expect(existsSync(join(f.root,'deployment-lock/upload-intent.json'))).toBe(true);}finally{f.close();}});
 it('reads an archived verified result after a crash without credentials or any new send',async()=>{const f=fixture();try{const lease=FileUploadLease.acquire(f.root,f.manifest.plan);await lease.dispatchOnce(async()=>{},async()=>{},AbortSignal.timeout(5000));await lease.reconcile(async()=>({version:'22222222-2222-2222-2222-222222222222',evidenceDigest:'d'.repeat(64)}),AbortSignal.timeout(5000));lease.release();expect(await executeUploadManifest(f.manifest,'upload',{},AbortSignal.timeout(5000))).toMatchObject({status:'already-verified'});expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe('{}');}finally{f.close();}});
 it('rejects absent credentials before acquiring an upload lease',async()=>{const f=fixture();try{await expect(executeUploadManifest(f.manifest,'upload',{},AbortSignal.timeout(5000))).rejects.toThrow();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);}finally{f.close();}});
 it('prints a fixed failure without input details on an actual CLI invocation',()=>{const child=spawnSync(process.execPath,['scripts/release-upload-cli.ts','invalid','synthetic-private-value'],{encoding:'utf8'});expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).toContain('RELEASE_UPLOAD_FAILED');expect(child.stderr).not.toContain('synthetic-private-value');});
});
