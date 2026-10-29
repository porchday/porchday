import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {deploymentPlanHash,type DeploymentPlan,type RecoveryJournal,type RecoveryState} from './deployment-recovery.ts';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-staging',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64)};
function fixture(){const root=mkdtempSync(join(tmpdir(),'porchday-lease-')),canonical=JSON.stringify({stagingVersion:plan.baselineVersion,stagingRuntimeSource:'c'.repeat(40),compatibleRollbackVersions:{staging:plan.baselineVersion}});writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});return{root,canonical};}
const journal=(phase:'prepared'|'complete'):RecoveryJournal=>({read:async()=>({v:1,revision:phase==='complete'?4:1,planHash:deploymentPlanHash(plan),phase,...(phase==='complete'?{candidateDeploymentId:uuid(5)}:{})}),write:async()=>{throw Error('unused');}});
describe('frontend deployment target',()=>{
 it.each(['complete','rolled-back'] as const)('finalizes %s without overwriting backend or asset provenance',async phase=>{
  const f=fixture(),frontend:DeploymentPlan={...plan,worker:'porchday-staging-edge',backendVersion:uuid(20),backendReaderFloor:uuid(21)};let lease:FileDeploymentLease|undefined;
  const before={stagingVersion:uuid(20),stagingRuntimeSource:'d'.repeat(40),stagingSource:'d'.repeat(40),stagingAssetsSource:'e'.repeat(40),compatibleRollbackVersions:{staging:uuid(21)},edgeRouting:{stagingEnabled:true,stagingFrontendVersion:plan.baselineVersion,stagingFrontendSource:'c'.repeat(40),stagingFrontendAssetsSource:'f'.repeat(40),productionEnabled:false}};
  const state:RecoveryState={v:1,revision:phase==='complete'?4:5,planHash:deploymentPlanHash(frontend),phase,candidateDeploymentId:uuid(5),...(phase==='rolled-back'?{rollbackDeploymentId:uuid(6)}:{})};const log:RecoveryJournal={read:async()=>state,write:async()=>{throw Error('unused');}};
  try{
   writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(before));lease=FileDeploymentLease.acquire(f.root,frontend);
   const snapshot=join(f.root,'snapshot.json'),version=phase==='complete'?plan.candidateVersion:plan.baselineVersion;
   writeFileSync(snapshot,JSON.stringify({workers:{'staging-edge':{active:version},staging:{active:uuid(99)}}}),{mode:0o600});await expect(lease.finalize(log,snapshot)).rejects.toThrow('SNAPSHOT_BACKEND_CHANGED');
   writeFileSync(snapshot,JSON.stringify({workers:{'staging-edge':{active:version},staging:{active:frontend.backendVersion}}}));await lease.finalize(log,snapshot);await lease.release(log);
   const record=await FileDeploymentLease.completed(f.root,frontend,log);
   expect(record).toMatchObject({...before,edgeRouting:{...before.edgeRouting,stagingFrontendVersion:version,stagingFrontendSource:phase==='complete'?plan.candidateSource:before.edgeRouting.stagingFrontendSource}});
   expect(record?.deploymentRecovery).toMatchObject({'staging-edge':{outcome:phase,version}});
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it.each(['disabled','backend','floor'] as const)('rejects a changed %s before acquiring an operation marker',kind=>{
  const f=fixture(),frontend:DeploymentPlan={...plan,worker:'porchday-staging-edge',backendVersion:uuid(20),backendReaderFloor:uuid(21)};
  try{
   const before={stagingVersion:kind==='backend'?uuid(99):uuid(20),stagingRuntimeSource:'d'.repeat(40),compatibleRollbackVersions:{staging:kind==='floor'?uuid(99):uuid(21)},edgeRouting:{stagingEnabled:kind!=='disabled',stagingFrontendVersion:plan.baselineVersion,stagingFrontendSource:'c'.repeat(40)}};
   writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(before));expect(()=>FileDeploymentLease.acquire(f.root,frontend)).toThrow(kind==='floor'?'READER_FLOOR':'FRONTEND_BACKEND');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  }finally{rmSync(f.root,{recursive:true,force:true});}
 });
 it('requires explicit backend pins for frontend plans and rejects them for API plans',()=>{
  expect(()=>deploymentPlanHash({...plan,worker:'porchday-staging-edge'})).toThrow('PLAN_OR_ROLLBACK');
  expect(()=>deploymentPlanHash({...plan,backendVersion:uuid(20),backendReaderFloor:uuid(21)})).toThrow('PLAN_OR_ROLLBACK');
 });
});
describe('deployment lease coordination',()=>{
 it('excludes a second controller and resumes the same unresolved operation after close',()=>{
  const f=fixture();let a:FileDeploymentLease|undefined,b:FileDeploymentLease|undefined;
  try{a=FileDeploymentLease.acquire(f.root,plan);expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow('LEASE_BUSY');a.close();expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);expect(()=>FileDeploymentLease.acquire(f.root,{...plan,operationId:uuid(9)})).toThrow('LEASE_HELD');b=FileDeploymentLease.acquire(f.root,plan);expect(b.assert(plan).stagingVersion).toBe(plan.baselineVersion);}
  finally{a?.close();b?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('leaves a legacy deployment lock untouched',()=>{
  const f=fixture();try{mkdirSync(join(f.root,'deployment-lock'),{mode:0o700});const path=join(f.root,'deployment-lock/owner.json'),legacy='{"owner":"another-rollout"}\n';writeFileSync(path,legacy,{mode:0o600});expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow('LEASE_HELD');expect(readFileSync(path,'utf8')).toBe(legacy);}
  finally{rmSync(f.root,{recursive:true,force:true});}
 });
 it('detects canonical drift and refuses an unacknowledged reader floor',()=>{
  const f=fixture();let lease:FileDeploymentLease|undefined;
  try{lease=FileDeploymentLease.acquire(f.root,plan);writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical+' ');expect(()=>lease!.assert(plan)).toThrow('CANONICAL_CHANGED');lease.close();}
  finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
  const g=fixture();try{const record=JSON.parse(g.canonical);record.compatibleRollbackVersions.staging=uuid(7);writeFileSync(join(g.root,'latest-verified-deployment.json'),JSON.stringify(record));expect(()=>FileDeploymentLease.acquire(g.root,plan)).toThrow('READER_FLOOR_NOT_ACKNOWLEDGED');expect(existsSync(join(g.root,'deployment-lock'))).toBe(false);}
  finally{rmSync(g.root,{recursive:true,force:true});}
 });
 it('retains unresolved markers and releases only a matching terminal journal',async()=>{
  const f=fixture();let lease:FileDeploymentLease|undefined;
  try{lease=FileDeploymentLease.acquire(f.root,plan);await expect(lease.release(journal('prepared'))).rejects.toThrow('OUTCOME_UNRESOLVED');expect(existsSync(join(f.root,'deployment-lock'))).toBe(true);await lease.finalize(journal('complete'));await lease.release(journal('complete'));expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(()=>lease!.assert(plan)).toThrow('NOT_HELD');}
  finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('does not release another operation or remove unexpected lock files',async()=>{
  const f=fixture();let lease:FileDeploymentLease|undefined;
  try{lease=FileDeploymentLease.acquire(f.root,plan);const wrong:RecoveryJournal={...journal('complete'),read:async()=>({...await journal('complete').read(),planHash:'d'.repeat(64)} as RecoveryState)};await expect(lease.release(wrong)).rejects.toThrow('OUTCOME_UNRESOLVED');await lease.finalize(journal('complete'));writeFileSync(join(f.root,'deployment-lock/unexpected'),'keep',{mode:0o600});await expect(lease.release(journal('complete'))).rejects.toThrow('DIRECTORY_CHANGED');expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);}
  finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('recovers the kernel lock after a real controller process crash without stealing a live lock',async()=>{
  const f=fixture(),moduleUrl=new URL('./deployment-recovery-lease.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {FileDeploymentLease} from ${JSON.stringify(moduleUrl)};const plan=JSON.parse(process.argv[2]);const lease=FileDeploymentLease.acquire(process.argv[1],plan);console.log('READY');setInterval(()=>lease.assert(plan),1000);`,f.root,JSON.stringify(plan)],{stdio:['ignore','pipe','pipe']});let lease:FileDeploymentLease|undefined;
  try{
   await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child startup timeout')),5000);child.stdout!.once('data',chunk=>{clearTimeout(timeout);String(chunk).includes('READY')?resolve():reject(Error('child not ready'));});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('child exited before readiness'));});});
   expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow('LEASE_BUSY');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
   expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);lease=FileDeploymentLease.acquire(f.root,plan);expect(lease.assert(plan).stagingVersion).toBe(plan.baselineVersion);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
});

it('connects the real lease and journal to recovery and rejects canonical drift at the POST boundary',async()=>{
 const {FileRecoveryJournal}=await import('./deployment-recovery-journal.ts');const {recoverDeployment}=await import('./deployment-recovery.ts');const {leasedDeploymentPorts}=await import('./deployment-recovery-lease.ts');
 for(const drift of [false,true]){
  const f=fixture();let lease:FileDeploymentLease|undefined;let writes=0;
  try{
   lease=FileDeploymentLease.acquire(f.root,plan);const journal=new FileRecoveryJournal(join(f.root,'journal'));let current={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null as string|null};
   const ports=leasedDeploymentPorts(plan,lease,journal,{
    authorize:async()=>{},observe:async()=>{if(drift)writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical+' ');return{...current};},verify:async()=> 'healthy',
    deploy:async(version,operationId)=>{writes++;current={version,operationId,deploymentId:uuid(5)};},
   });
   expect(await recoverDeployment(plan,journal,ports,{sleep:async()=>{}})).toBe(drift?'observation-unavailable':'complete');expect(writes).toBe(drift?0:1);
   if(!drift){await lease.finalize(journal);await lease.release(journal);expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);}
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 }
});

it('resumes a real process crash after dispatch without repeating the simulated provider write',async()=>{
 const {FileRecoveryJournal}=await import('./deployment-recovery-journal.ts');const {recoverDeployment}=await import('./deployment-recovery.ts');const {leasedDeploymentPorts}=await import('./deployment-recovery-lease.ts');
 const f=fixture(),leaseUrl=new URL('./deployment-recovery-lease.ts',import.meta.url).href,journalUrl=new URL('./deployment-recovery-journal.ts',import.meta.url).href,recoveryUrl=new URL('./deployment-recovery.ts',import.meta.url).href;
 writeFileSync(join(f.root,'provider.json'),JSON.stringify({version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null}),{mode:0o600});
 const code=`import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {FileDeploymentLease,leasedDeploymentPorts} from ${JSON.stringify(leaseUrl)};import {FileRecoveryJournal} from ${JSON.stringify(journalUrl)};import {recoverDeployment} from ${JSON.stringify(recoveryUrl)};const root=process.argv[1],plan=JSON.parse(process.argv[2]),lease=FileDeploymentLease.acquire(root,plan),journal=new FileRecoveryJournal(join(root,'journal'));await recoverDeployment(plan,journal,leasedDeploymentPorts(plan,lease,journal,{authorize:async()=>{},observe:async()=>JSON.parse(readFileSync(join(root,'provider.json'),'utf8')),verify:async()=> 'healthy',deploy:async(version,operationId)=>{writeFileSync(join(root,'provider.json'),JSON.stringify({version,operationId,deploymentId:${JSON.stringify(uuid(5))}}));console.log('DISPATCHED');await new Promise(()=>{});}}));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.root,JSON.stringify(plan)],{stdio:['ignore','pipe','pipe']});let lease:FileDeploymentLease|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child dispatch timeout')),5000);child.stdout!.once('data',chunk=>{clearTimeout(timeout);String(chunk).includes('DISPATCHED')?resolve():reject(Error('child did not dispatch'));});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('child exited before dispatch'));});});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;const journal=new FileRecoveryJournal(join(f.root,'journal'));expect((await journal.read())?.phase).toBe('activation-intent');
  lease=FileDeploymentLease.acquire(f.root,plan);let repeats=0;const ports=leasedDeploymentPorts(plan,lease,journal,{authorize:async()=>{},observe:async()=>JSON.parse(readFileSync(join(f.root,'provider.json'),'utf8')),verify:async()=> 'healthy',deploy:async()=>{repeats++;}});
  expect(await recoverDeployment(plan,journal,ports)).toBe('complete');expect(repeats).toBe(0);await lease.finalize(journal);await lease.release(journal);expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}lease?.close();rmSync(f.root,{recursive:true,force:true});}
});

it.each(['before-replace','after-replace','after-release'])('resumes finalization after real process loss at %s',async boundary=>{
 const f=fixture(),moduleUrl=new URL('./deployment-recovery-lease.ts',import.meta.url).href,state=await journal('complete').read();
 const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';
 const boundary=process.argv[3];if(boundary==='before-replace'){const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(basename(to)==='latest-verified-deployment.json'){fs.writeSync(1,'BOUNDARY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return rename(from,to);};syncBuiltinESMExports();}
 const {FileDeploymentLease}=await import(${JSON.stringify(moduleUrl)});const plan=JSON.parse(process.argv[2]),lease=FileDeploymentLease.acquire(process.argv[1],plan),journal={read:async()=>(${JSON.stringify(state)}),write:async()=>{throw Error('unused');}};
 await lease.finalize(journal);if(boundary==='after-release')await lease.release(journal);fs.writeSync(1,'BOUNDARY\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.root,JSON.stringify(plan),boundary],{stdio:['ignore','pipe','pipe']});let lease:FileDeploymentLease|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child finalization timeout')),5000);child.stdout!.once('data',chunk=>{clearTimeout(timeout);String(chunk).includes('BOUNDARY')?resolve():reject(Error('unexpected child output'));});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('child exited before finalization boundary'));});});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  if(boundary==='before-replace')expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
  if(boundary!=='after-release'){
   lease=FileDeploymentLease.acquire(f.root,plan);expect(()=>lease!.assert(plan)).toThrow('FINALIZATION_IN_PROGRESS');await lease.finalize(journal('complete'));await lease.release(journal('complete'));
  }
  expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  const completed=await FileDeploymentLease.completed(f.root,plan,journal('complete'));
  expect(completed?.stagingVersion).toBe(plan.candidateVersion);expect(completed?.stagingRuntimeSource).toBe(plan.candidateSource);
  expect(JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8'))).toEqual(completed);
  expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow('ALREADY_FINALIZED');
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}lease?.close();rmSync(f.root,{recursive:true,force:true});}
});

it('requires finalization before release and rejects canonical drift or receipt tampering on resume',async()=>{
 for(const tamper of ['canonical','receipt']){
  const f=fixture();let lease:FileDeploymentLease|undefined;
  try{
   lease=FileDeploymentLease.acquire(f.root,plan);await expect(lease.release(journal('complete'))).rejects.toThrow('FINALIZATION_REQUIRED');await lease.finalize(journal('complete'));lease.close();
   if(tamper==='canonical')writeFileSync(join(f.root,'latest-verified-deployment.json'),'{}');
   else{const path=join(f.root,'deployment-lock/finalization.json'),receipt=JSON.parse(readFileSync(path,'utf8'));receipt.after='{}';writeFileSync(path,JSON.stringify(receipt));}
   expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow(tamper==='canonical'?'CANONICAL_CHANGED':'FINALIZATION_INVALID');expect(existsSync(join(f.root,'deployment-lock'))).toBe(true);
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 }
});

it('records rollback deployment identity while preserving baseline source and unrelated state',async()=>{
 const f=fixture();let lease:FileDeploymentLease|undefined;
 const state:RecoveryState={v:1,revision:5,planHash:deploymentPlanHash(plan),phase:'rolled-back',candidateDeploymentId:uuid(5),rollbackDeploymentId:uuid(6)},rollback:RecoveryJournal={read:async()=>state,write:async()=>{throw Error('unused');}};
 try{
  const baseline={...JSON.parse(f.canonical),productionVersion:uuid(10),schemaMigrationsByEnvironment:{staging:['056']},sourceComposition:'preserve'};writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(baseline));
  lease=FileDeploymentLease.acquire(f.root,plan);await lease.finalize(rollback);await lease.finalize(rollback);await lease.release(rollback);
  const record=await FileDeploymentLease.completed(f.root,plan,rollback);expect(record).toMatchObject(baseline);expect(record?.deploymentRecovery).toMatchObject({staging:{version:plan.baselineVersion,source:'c'.repeat(40),deploymentId:uuid(6),outcome:'rolled-back'}});
 }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
});

it('pins the verified provider snapshot and rejects a wrong version or changed evidence',async()=>{
 const f=fixture();let lease:FileDeploymentLease|undefined;
 try{
  const path=join(f.root,'provider-final.json');writeFileSync(path,JSON.stringify({workers:{staging:{active:uuid(9)}}}),{mode:0o600});
  lease=FileDeploymentLease.acquire(f.root,plan);await expect(lease.finalize(journal('complete'),path)).rejects.toThrow('SNAPSHOT_VERSION_CHANGED');
  writeFileSync(path,JSON.stringify({workers:{staging:{active:plan.candidateVersion}}}));await lease.finalize(journal('complete'),path);
  const canonical=JSON.parse(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8'));expect(canonical.latestProviderSnapshot).toBe(path);expect(canonical.deploymentRecovery.staging.providerSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  lease.close();writeFileSync(path,'{}');expect(()=>FileDeploymentLease.acquire(f.root,plan)).toThrow('SNAPSHOT_CHANGED');expect(existsSync(join(f.root,'deployment-lock'))).toBe(true);
 }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
});
