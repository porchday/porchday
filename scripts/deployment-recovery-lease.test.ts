import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {deploymentPlanHash,rollbackOperationId,type DeploymentPlan,type RecoveryJournal,type RecoveryState} from './deployment-recovery.ts';
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
 it.each(['staging','production'])('rejects %s application asset promotion behind an active edge before creating a lease marker',environment=>{
  const f=fixture(),app={...plan,worker:'porchday-'+environment,assetManifests:{candidate:'a'.repeat(64),baseline:'b'.repeat(64)}};let lease:FileDeploymentLease|undefined;
  const canonical={ [environment+'Version']:plan.baselineVersion,[environment+'RuntimeSource']:'c'.repeat(40),compatibleRollbackVersions:{[environment]:plan.baselineVersion},edgeRouting:{[environment+'Enabled']:true}};
  try{
   writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(canonical));
   expect(()=>FileDeploymentLease.acquire(f.root,app)).toThrow('ASSETS_NOT_PUBLIC_TARGET');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
   canonical.edgeRouting[environment+'Enabled']=false;writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(canonical));
   lease=FileDeploymentLease.acquire(f.root,app);expect(lease.assert(app)[environment+'Version']).toBe(plan.baselineVersion);
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
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
   lease=FileDeploymentLease.acquire(f.root,plan);expect(()=>lease!.assert(plan)).toThrow('FINALIZATION_IN_PROGRESS');expect(await lease.resumeFinalization(journal('complete'))).toBe(true);
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

describe('monitor recovery canonical state',()=>{
 it.each((['staging','production'] as const).flatMap(environment=>(['complete','rolled-back'] as const).map(phase=>({environment,phase}))))('finalizes $environment $phase without changing app, edge, history or other monitor',async({environment,phase})=>{
  const f=fixture(),key='monitor-'+environment,monitorPlan:DeploymentPlan={...plan,worker:'porchday-'+key};let lease:FileDeploymentLease|undefined;
  try{
   const before={stagingVersion:uuid(20),productionVersion:uuid(21),stagingRuntimeSource:'d'.repeat(40),productionRuntimeSource:'e'.repeat(40),edgeRouting:{stagingFrontendVersion:uuid(22)},monitorVersions:{staging:environment==='staging'?plan.baselineVersion:uuid(23),production:environment==='production'?plan.baselineVersion:uuid(24)},monitorSources:{staging:'c'.repeat(40),production:'c'.repeat(40)},compatibleRollbackVersions:{[key]:plan.baselineVersion},availabilityObjective:{historyStartedAt:{staging:'2026-10-27T22:09:00Z',production:'2026-10-27T22:13:00Z'}}};
   writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(before));lease=FileDeploymentLease.acquire(f.root,monitorPlan);
   const log:RecoveryJournal={read:async()=>({v:1,revision:phase==='complete'?4:5,planHash:deploymentPlanHash(monitorPlan),phase,candidateDeploymentId:uuid(5),...(phase==='rolled-back'?{rollbackDeploymentId:uuid(6)}:{})}),write:async()=>{throw Error('unused');}};
   await expect(lease.finalize(log)).rejects.toThrow('MONITOR_SNAPSHOT_REQUIRED');
   const snapshot=join(f.root,'monitor-snapshot.json'),version=phase==='complete'?plan.candidateVersion:plan.baselineVersion;
   writeFileSync(snapshot,JSON.stringify({workers:{[key]:{active:version}}}),{mode:0o600});await lease.finalize(log,snapshot);await lease.release(log);
   const after=await FileDeploymentLease.completed(f.root,monitorPlan,log);
   expect(after).toMatchObject({...before,monitorVersions:{...before.monitorVersions,[environment]:version},monitorSources:{...before.monitorSources,[environment]:phase==='complete'?plan.candidateSource:'c'.repeat(40)}});
   expect(after?.deploymentRecovery).toMatchObject({[key]:{outcome:phase,version}});
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it.each(['source','version','floor'])('refuses missing or mismatched monitor %s before marker creation',kind=>{
  const f=fixture(),monitorPlan={...plan,worker:'porchday-monitor-staging'};
  try{
   const before={monitorVersions:{staging:kind==='version'?uuid(99):plan.baselineVersion},monitorSources:{staging:kind==='source'?undefined:'c'.repeat(40)},compatibleRollbackVersions:{'monitor-staging':kind==='floor'?uuid(99):plan.baselineVersion}};
   writeFileSync(join(f.root,'latest-verified-deployment.json'),JSON.stringify(before));expect(()=>FileDeploymentLease.acquire(f.root,monitorPlan)).toThrow();expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
  }finally{rmSync(f.root,{recursive:true,force:true});}
 });
 it('does not accept application asset manifests on monitor plans',()=>{
  expect(()=>deploymentPlanHash({...plan,worker:'porchday-monitor-staging',assetManifests:{candidate:'a'.repeat(64),baseline:'b'.repeat(64)}})).toThrow('MONITOR_ASSETS_FORBIDDEN');
 });
});

describe('failed monitor rollback disposition',()=>{
 function setup(){
  const f=fixture(),monitor={...plan,worker:'porchday-monitor-staging'},canonical=JSON.stringify({stagingVersion:uuid(20),monitorVersions:{staging:plan.baselineVersion},monitorSources:{staging:'c'.repeat(40)},compatibleRollbackVersions:{'monitor-staging':plan.baselineVersion}});
  writeFileSync(join(f.root,'latest-verified-deployment.json'),canonical);
  let state:RecoveryState={v:1,revision:4,planHash:deploymentPlanHash(monitor),phase:'rollback-intent',candidateDeploymentId:uuid(5)};
  const log:RecoveryJournal={read:async()=>state,write:async()=>{throw Error('must not change journal');}};
  const result={observation:{version:monitor.baselineVersion,operationId:rollbackOperationId(monitor.operationId),deploymentId:uuid(6)},evidenceDigest:'d'.repeat(64),reason:'MONITOR_UNAVAILABLE_AFTER_ROLLBACK' as const};
  return{...f,canonical,monitor,log,result,setState:(next:RecoveryState)=>{state=next;}};
 }
 it('archives failure without claiming health or changing canonical/journal, and permanently forbids replay',async()=>{
  const f=setup(),lease=FileDeploymentLease.acquire(f.root,f.monitor);try{
   await lease.resolveFailedMonitorRollback(f.log,async()=>f.result,AbortSignal.timeout(5000));
   expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);expect((await f.log.read())?.phase).toBe('rollback-intent');
   expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(existsSync(join(f.root,'deployment-recovery-failed-'+plan.operationId+'/failed-recovery.json'))).toBe(true);
   expect(await FileDeploymentLease.completed(f.root,f.monitor,f.log)).toBe(null);expect(()=>FileDeploymentLease.acquire(f.root,f.monitor)).toThrow('ALREADY_RESOLVED_FAILED');
   const next=FileDeploymentLease.acquire(f.root,{...f.monitor,operationId:uuid(40)});next.close();
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it.each(['read-failure','wrong-operation','wrong-version','invalid-digest','journal-change','canonical-change','unexpected-file'] as const)('retains unresolved evidence on %s',async kind=>{
  const f=setup(),lease=FileDeploymentLease.acquire(f.root,f.monitor);try{
   await expect(lease.resolveFailedMonitorRollback(f.log,async()=>{
    if(kind==='read-failure')throw Error('provider unavailable');
    if(kind==='wrong-operation')return{...f.result,observation:{...f.result.observation,operationId:uuid(40)}};
    if(kind==='wrong-version')return{...f.result,observation:{...f.result.observation,version:plan.candidateVersion}};
    if(kind==='invalid-digest')return{...f.result,evidenceDigest:'invalid'};
    if(kind==='journal-change')f.setState({...await f.log.read() as RecoveryState,revision:5});
    if(kind==='canonical-change')writeFileSync(join(f.root,'latest-verified-deployment.json'),f.canonical+' ');
    if(kind==='unexpected-file')writeFileSync(join(f.root,'deployment-lock/extra'),'x',{mode:0o600});
    return f.result;
   },AbortSignal.timeout(5000))).rejects.toThrow();expect(existsSync(join(f.root,'deployment-lock/owner.json'))).toBe(true);expect(existsSync(join(f.root,'deployment-lock/failed-recovery.json'))).toBe(false);
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('resumes interrupted local archival and blocks regular controller operations',async()=>{
  const f=setup();let lease=FileDeploymentLease.acquire(f.root,f.monitor);try{
   const record={v:1,planHash:deploymentPlanHash(f.monitor),journal:await f.log.read(),...f.result};writeFileSync(join(f.root,'deployment-lock/failed-recovery.json'),JSON.stringify(record)+'\n',{mode:0o600});lease.close();lease=FileDeploymentLease.acquire(f.root,f.monitor);
   expect(()=>lease.assert(f.monitor)).toThrow('FAILURE_RESOLUTION_IN_PROGRESS');
   await expect(lease.resolveFailedMonitorRollback(f.log,async()=>({...f.result,evidenceDigest:'e'.repeat(64)}),AbortSignal.timeout(5000))).rejects.toThrow('PROOF_CHANGED');
   await lease.resolveFailedMonitorRollback(f.log,async()=>f.result,AbortSignal.timeout(5000));
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('holds the kernel lease and rejects concurrent release operations through asynchronous inspection',async()=>{
  const f=setup(),lease=FileDeploymentLease.acquire(f.root,f.monitor);try{
   await lease.resolveFailedMonitorRollback(f.log,async()=>{
    expect(()=>lease.close()).toThrow('RESOLUTION_IN_PROGRESS');expect(()=>lease.assert(f.monitor)).toThrow('RESOLUTION_IN_PROGRESS');
    expect(()=>FileDeploymentLease.acquire(f.root,f.monitor)).toThrow('LEASE_BUSY');
    await expect(lease.resolveFailedMonitorRollback(f.log,async()=>f.result,AbortSignal.timeout(5000))).rejects.toThrow('RESOLUTION_IN_PROGRESS');return f.result;
   },AbortSignal.timeout(5000));
  }finally{lease.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('cannot use the disposition for application deployments or an unrolled monitor candidate',async()=>{
  const f=fixture(),app=FileDeploymentLease.acquire(f.root,plan);try{await expect(app.resolveFailedMonitorRollback(journal('prepared'),async()=>{throw Error('must not run');},AbortSignal.timeout(5000))).rejects.toThrow('UNSAFE');}finally{app.close();rmSync(f.root,{recursive:true,force:true});}
  const m=setup(),lease=FileDeploymentLease.acquire(m.root,m.monitor);try{m.setState({v:1,revision:3,planHash:deploymentPlanHash(m.monitor),phase:'candidate-observed',candidateDeploymentId:uuid(5)});await expect(lease.resolveFailedMonitorRollback(m.log,async()=>m.result,AbortSignal.timeout(5000))).rejects.toThrow('UNSAFE');}finally{lease.close();rmSync(m.root,{recursive:true,force:true});}
 });
});


describe('schema finalization receipt integrity',()=>{
 it.each(['scope','fingerprint','tamper'])('rejects %s without accepting changed evidence',async kind=>{
  const f=fixture();let lease:FileDeploymentLease|undefined;
  try{
   const path=join(f.root,'schema.json'),proof={kind:'schema-proof',operationId:plan.operationId,planHash:deploymentPlanHash(plan),worker:plan.worker,version:plan.candidateVersion,branchId:'synthetic',schema:{version:1,migrations:['000_initial.sql'],functionsSha256:'a'.repeat(64),columnsSha256:'b'.repeat(64)}};
   if(kind==='scope')proof.version=uuid(99);
   if(kind==='fingerprint')proof.schema.functionsSha256='invalid';
   writeFileSync(path,JSON.stringify(proof),{mode:0o600});lease=FileDeploymentLease.acquire(f.root,plan);
   if(kind==='tamper'){
    await lease.finalize(journal('complete'),undefined,undefined,path);
    const canonical=readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8');
    writeFileSync(path,JSON.stringify({...proof,branchId:'changed'}));
    await expect(lease.resumeFinalization(journal('complete'))).rejects.toThrow();
    expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(canonical);
   }else{
    await expect(lease.finalize(journal('complete'),undefined,undefined,path)).rejects.toThrow('SCHEMA_PROOF_INVALID');
    expect(readFileSync(join(f.root,'latest-verified-deployment.json'),'utf8')).toBe(f.canonical);
   }
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
});


describe('observed canonical finalization',()=>{
 it.each(['complete','rolled-back'] as const)('accepts only original bytes or the exact %s receipt before and after archival',async phase=>{
  const f=fixture();let lease:FileDeploymentLease|undefined;
  const state:RecoveryState={v:1,revision:5,planHash:deploymentPlanHash(plan),phase,candidateDeploymentId:uuid(5),...(phase==='rolled-back'?{rollbackDeploymentId:uuid(6)}:{})};
  const log:RecoveryJournal={read:async()=>state,write:async()=>{throw Error('unused');}};
  try{
   const canonicalPath=join(f.root,'latest-verified-deployment.json'),schemaPath=join(f.root,'schema.json');
   const proof={kind:'schema-proof',operationId:plan.operationId,planHash:deploymentPlanHash(plan),worker:plan.worker,version:phase==='complete'?plan.candidateVersion:plan.baselineVersion,branchId:'synthetic',schema:{version:1,migrations:['000_initial.sql'],functionsSha256:'a'.repeat(64),columnsSha256:'b'.repeat(64)}};
   writeFileSync(schemaPath,JSON.stringify(proof),{mode:0o600});
   FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical);lease=FileDeploymentLease.acquire(f.root,plan);
   writeFileSync(canonicalPath,JSON.stringify({...JSON.parse(f.canonical),schemaMigrationsByEnvironment:{staging:1}}));
   expect(()=>FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical)).toThrow();writeFileSync(canonicalPath,f.canonical);
   await lease.finalize(log,undefined,undefined,schemaPath);
   FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical);await lease.release(log);
   FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical);
   const finalized=readFileSync(canonicalPath,'utf8');
   for(const changed of [{...JSON.parse(finalized),productionVersion:uuid(99)},{...JSON.parse(finalized),schemaMigrationsByEnvironment:{staging:99}}]){
    writeFileSync(canonicalPath,JSON.stringify(changed));expect(()=>FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical)).toThrow();
   }
   writeFileSync(canonicalPath,finalized);
   expect(()=>FileDeploymentLease.assertObservedCanonical(f.root,{...plan,operationId:uuid(99)},f.canonical)).toThrow();
   expect(()=>FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical+' ')).toThrow();
   writeFileSync(schemaPath,JSON.stringify({...proof,branchId:'changed'}));
   expect(()=>FileDeploymentLease.assertObservedCanonical(f.root,plan,f.canonical)).toThrow('SCHEMA_PROOF_CHANGED');
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
});


describe('reviewed reader floor promotion',()=>{
 it.each(['complete','rolled-back'] as const)('promotes only on complete and preserves the old floor on %s',async phase=>{
  const f=fixture(),promote:DeploymentPlan={...plan,readerFloorPromotion:{protocol:'privacy-commit-v1',previousVersion:plan.baselineVersion}};let lease:FileDeploymentLease|undefined;
  const state:RecoveryState={v:1,revision:5,planHash:deploymentPlanHash(promote),phase,candidateDeploymentId:uuid(5),...(phase==='rolled-back'?{rollbackDeploymentId:uuid(6)}:{})};const log:RecoveryJournal={read:async()=>state,write:async()=>{throw Error('unused');}};
  try{
   const before=JSON.stringify({...JSON.parse(f.canonical),compatibleRollbackVersions:{staging:plan.baselineVersion,production:uuid(80)}});writeFileSync(join(f.root,'latest-verified-deployment.json'),before);
   lease=FileDeploymentLease.acquire(f.root,promote);await expect(lease.finalize(log)).rejects.toThrow('READER_FLOOR_PROOF_REQUIRED');
   const snapshot=join(f.root,'snapshot.json'),schema=join(f.root,'schema.json'),version=phase==='complete'?plan.candidateVersion:plan.baselineVersion;
   writeFileSync(snapshot,JSON.stringify({workers:{staging:{active:version,resources:{bindings:[{name:'PRIVACY_COMMIT_RECOVERY_V1',type:'plain_text',text:'true'}]}}}}),{mode:0o600});
   writeFileSync(schema,JSON.stringify({kind:'schema-proof',operationId:plan.operationId,planHash:deploymentPlanHash(promote),worker:plan.worker,version,branchId:'synthetic',schema:{version:1,migrations:['057_privacy_transaction_commits.sql'],functionsSha256:'a'.repeat(64),columnsSha256:'b'.repeat(64)}}),{mode:0o600});
   const snapshotBytes=readFileSync(snapshot);writeFileSync(snapshot,JSON.stringify({workers:{staging:{active:version,resources:{bindings:[{name:'PRIVACY_COMMIT_WRITER_V1',type:'plain_text',text:'true'}]}}}}));
   await expect(lease.finalize(log,snapshot,undefined,schema)).rejects.toThrow('READER_FLOOR_PROOF_REQUIRED');writeFileSync(snapshot,snapshotBytes);
   await lease.finalize(log,snapshot,undefined,schema);FileDeploymentLease.assertObservedCanonical(f.root,promote,before);lease.close();
   lease=FileDeploymentLease.acquire(f.root,promote);expect(await lease.resumeFinalization(log)).toBe(true);
   const record=await FileDeploymentLease.completed(f.root,promote,log);expect(record?.compatibleRollbackVersions).toEqual({staging:version,production:uuid(80)});
  }finally{lease?.close();rmSync(f.root,{recursive:true,force:true});}
 });
 it('rejects a stale floor even when the plan acknowledges both versions',()=>{const f=fixture();try{
  const changed={...plan,compatibleRollbackVersions:[plan.baselineVersion,uuid(8)],readerFloorPromotion:{protocol:'privacy-commit-v1' as const,previousVersion:uuid(8)}};
  expect(()=>FileDeploymentLease.preflight(f.root,changed)).toThrow('READER_FLOOR_CHANGED');
  expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);
 }finally{rmSync(f.root,{recursive:true,force:true});}});
});
