import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {FileUploadLease,type UploadPlan} from './release-upload-lease.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import type {DeploymentPlan} from './deployment-recovery.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const signal=()=>AbortSignal.timeout(5000);
const recovery:DeploymentPlan={operationId:id(9),worker:'porchday-staging',candidateVersion:id(2),candidateSource:'a'.repeat(40),baselineVersion:id(3),baselineDeploymentId:id(4),compatibleRollbackVersions:[id(3)],evidenceDigest:'b'.repeat(64)};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'porchday-upload-'));
 const canonical=JSON.stringify({stagingVersion:id(3),stagingRuntimeSource:'c'.repeat(40),compatibleRollbackVersions:{staging:id(3)}});
 writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});
 const plan:UploadPlan={operationId:id(1),worker:'porchday-staging',source:'a'.repeat(40),canonicalSha256:createHash('sha256').update(canonical).digest('hex'),evidenceDigest:'b'.repeat(64)};
 return{root,plan,canonical};
}
const verified=async()=>({version:id(2),evidenceDigest:'d'.repeat(64)});
describe('durable inactive upload lease',()=>{
 it('excludes upload and deployment controllers using the same kernel and persistent locks',()=>{
  for(const first of ['upload','deployment']){
   const f=fixture();let lease:FileUploadLease|FileDeploymentLease|undefined;
   try{
    lease=first==='upload'?FileUploadLease.acquire(f.root,f.plan):FileDeploymentLease.acquire(f.root,recovery);
    const second=()=>first==='upload'?FileDeploymentLease.acquire(f.root,recovery):FileUploadLease.acquire(f.root,f.plan);
    expect(second).toThrow('LEASE_BUSY');lease.close();expect(second).toThrow('LEASE_HELD');
   }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
  }
 });
 it('persists intent before dispatch and never repeats an ambiguous write after resume',async()=>{
  const f=fixture();let lease=FileUploadLease.acquire(f.root,f.plan),calls=0;
  try{
   expect(await lease.dispatchOnce(async()=>{},async operation=>{calls++;expect(operation).toBe(f.plan.operationId);expect(JSON.parse(readFileSync(join(f.root,'deployment-lock/upload-intent.json'),'utf8')).operationId).toBe(operation);throw Error('ambiguous provider response');},signal())).toBe('reconcile');
   expect(()=>lease.release()).toThrow('RECONCILIATION_REQUIRED');lease.close();lease=FileUploadLease.acquire(f.root,f.plan);
   expect(await lease.dispatchOnce(async()=>{throw Error('must not authorize another send');},async()=>{calls++;},signal())).toBe('reconcile');expect(calls).toBe(1);
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('does not leave an intent on failed authorization, and holds the lock through asynchronous dispatch',async()=>{
  const f=fixture(),lease=FileUploadLease.acquire(f.root,f.plan);
  try{
   await expect(lease.dispatchOnce(async()=>{throw Error('CI failed');},async()=>{},signal())).rejects.toThrow('CI failed');expect(existsSync(join(f.root,'deployment-lock/upload-intent.json'))).toBe(false);
   let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve;});
   const pending=lease.dispatchOnce(async()=>{await gate;},async()=>{},signal());
   await expect(lease.dispatchOnce(async()=>{},async()=>{},signal())).rejects.toThrow('UPLOAD_IN_PROGRESS');expect(()=>lease.close()).toThrow('UPLOAD_IN_PROGRESS');
   done();expect(await pending).toBe('dispatched');
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('requires reconciliation, archives evidence and leaves canonical active state unchanged',async()=>{
  const f=fixture(),lease=FileUploadLease.acquire(f.root,f.plan);
  try{
   await expect(lease.reconcile(verified,signal())).rejects.toThrow('INTENT_REQUIRED');
   await lease.dispatchOnce(async()=>{},async()=>{},signal());await lease.reconcile(verified,signal());
   await expect(lease.reconcile(async()=>({...await verified(),version:id(8)}),signal())).rejects.toThrow('VERIFICATION_CHANGED');
   expect(lease.release().version).toBe(id(2));expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
   expect(existsSync(join(f.root,'release-upload-completed-'+f.plan.operationId+'/upload-intent.json'))).toBe(true);
   expect(FileUploadLease.completed(f.root,f.plan)).toMatchObject(await verified());
   expect(()=>FileUploadLease.completed(f.root,{...f.plan,evidenceDigest:'e'.repeat(64)})).toThrow('LEASE_CHANGED');
   expect(()=>FileUploadLease.acquire(f.root,f.plan)).toThrow('ALREADY_COMPLETED');
   const activation=FileDeploymentLease.acquire(f.root,recovery);activation.close();
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('fails closed on partial intent, changed plans, canonical drift and unexpected directory contents',async()=>{
  const f=fixture();let lease=FileUploadLease.acquire(f.root,f.plan);
  try{
   lease.close();expect(()=>FileUploadLease.acquire(f.root,{...f.plan,evidenceDigest:'e'.repeat(64)})).toThrow('LEASE_HELD');
   writeFileSync(join(f.root,'deployment-lock/upload-intent.json'),'{',{mode:0o600});expect(()=>FileUploadLease.acquire(f.root,f.plan)).toThrow('INTENT_INVALID');
   rmSync(join(f.root,'deployment-lock/upload-intent.json'));lease=FileUploadLease.acquire(f.root,f.plan);
   writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical+' ');await expect(lease.dispatchOnce(async()=>{},async()=>{},signal())).rejects.toThrow('CANONICAL_CHANGED');
   writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical);await lease.dispatchOnce(async()=>{},async()=>{},signal());await lease.reconcile(verified,signal());
   writeFileSync(join(f.root,'deployment-lock/unexpected'),'x',{mode:0o600});expect(()=>lease.release()).toThrow('DIRECTORY_CHANGED');
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('resumes after SIGKILL without replaying a dispatched upload',async()=>{
  const f=fixture();let child:ReturnType<typeof spawn>|undefined,lease:FileUploadLease|undefined;
  try{
   const code=`import {FileUploadLease} from ${JSON.stringify(new URL('./release-upload-lease.ts',import.meta.url).href)};
const lease=FileUploadLease.acquire(${JSON.stringify(f.root)},${JSON.stringify(f.plan)});
await lease.dispatchOnce(async()=>{},async()=>{process.send('sent');await new Promise(()=>{});},new AbortController().signal);
setInterval(()=>{},1000);`;
   child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc']});
   const message=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited before dispatch');}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout')),5000);timer.unref();})]);
   expect(message[0]).toBe('sent');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
   lease=FileUploadLease.acquire(f.root,f.plan);let sent=0;expect(await lease.dispatchOnce(async()=>{},async()=>{sent++;},signal())).toBe('reconcile');expect(sent).toBe(0);
   await lease.reconcile(verified,signal());lease.release();
  }finally{if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('retains an intent after cancellation and refuses failed reconciliation',async()=>{
  const f=fixture(),lease=FileUploadLease.acquire(f.root,f.plan),abort=new AbortController();let calls=0;
  try{
   expect(await lease.dispatchOnce(async()=>{},async()=>{calls++;abort.abort();},abort.signal)).toBe('reconcile');
   await expect(lease.reconcile(async()=>{throw Error('provider unavailable');},signal())).rejects.toThrow('provider unavailable');
   expect(()=>lease.release()).toThrow('RECONCILIATION_REQUIRED');expect(existsSync(join(f.root,'deployment-lock/upload-verified.json'))).toBe(false);
   expect(await lease.dispatchOnce(async()=>{},async()=>{calls++;},signal())).toBe('reconcile');expect(calls).toBe(1);
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
});
