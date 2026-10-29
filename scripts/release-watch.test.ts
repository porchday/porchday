import {createContinuityGate} from './release-continuity-gate.ts';
import type {ContinuityCommandEvent} from './release-continuity-command.ts';
import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {registerReleaseWatch,inspectReleaseWatch,listReleaseWatches} from './release-watch.ts';
import {pollReleaseWatches,type WatchDeliveryState} from './release-watch-delivery.ts';
import {releaseAlertBody,queueReleaseAlert} from './release-alerts.ts';
import type {GitHubTransport} from './external-monitor-github.ts';
import {deploymentPlanHash,type RecoveryState} from './deployment-recovery.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
const id=(n:number)=>String(n).padStart(8,'0')+'-1111-1111-1111-111111111111',source='a'.repeat(40),at=new Date('2026-10-29T00:00:00.000Z');
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'release-watch-'))),journalDirectory=join(root,'journal'),proofDirectory=join(root,'proofs');for(const d of [journalDirectory,proofDirectory])mkdirSync(d,{mode:0o700});const plan={operationId:id(1),worker:'porchday-staging',candidateVersion:id(2),baselineVersion:id(3),baselineDeploymentId:id(4),candidateSource:source,compatibleRollbackVersions:[id(3)],evidenceDigest:'b'.repeat(64)};writeFileSync(join(root,'latest-verified-deployment.json'),JSON.stringify({stagingVersion:id(3),stagingRuntimeSource:source,compatibleRollbackVersions:{staging:id(3)}}),{mode:0o600});const w=registerReleaseWatch({root,plan,journalDirectory,proofDirectory},at);return{w,close:()=>rmSync(root,{recursive:true,force:true})};}
it('retains the original failure event if only its durable marker survived',async()=>{
 const f=fixture();try{
  const event=queueReleaseAlert(f.w.proofDirectory,f.w.plan,'command-failed',at);rmSync(join(f.w.proofDirectory,'attention-'+id(1)+'.json'));
  expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+1000))).toEqual({status:'attention',event});
  expect(queueReleaseAlert(f.w.proofDirectory,f.w.plan,'command-failed',new Date(at.getTime()+2000))).toEqual(event);
 }finally{f.close();}
});
it.each(['complete','rolled-back','cancelled'] as const)('delivers an explicit failure alert after %s without changing terminal history',async outcome=>{
 const f=fixture();try{
  const lease=FileDeploymentLease.acquire(f.w.root,f.w.plan),journal=new FileRecoveryJournal(f.w.journalDirectory);
  if(outcome==='cancelled'){await lease.cancelBeforeIntent(journal);lease.close();}
  else{
   const phases:RecoveryState['phase'][]=['prepared','activation-intent','candidate-observed',...(outcome==='complete'?['complete' as const]:['rollback-intent' as const,'rolled-back' as const])];let previous:RecoveryState|null=null;
   for(const [i,phase] of phases.entries()){const next:RecoveryState={v:1,revision:i+1,planHash:deploymentPlanHash(f.w.plan),phase,...(i>=2?{candidateDeploymentId:id(5)}:{}),...(phase==='rolled-back'?{rollbackDeploymentId:id(6)}:{})};await journal.write(previous,next);previous=next;}
   await lease.finalize(journal);await lease.release(journal);
  }
  const history=await journal.read(),canonical=readFileSync(join(f.w.root,'latest-verified-deployment.json'));
  const event=queueReleaseAlert(f.w.proofDirectory,f.w.plan,'command-failed',new Date(at.getTime()+1000));
  expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+1001))).toEqual({status:'attention',event});
  let posts=0;const records=new Map<string,WatchDeliveryState>(),store={read:(key:string)=>records.get(key)??null,write:(key:string,value:WatchDeliveryState)=>{records.set(key,value);}};
  const transport:GitHubTransport=async(method,path)=>{if(method==='GET')return path.includes('/comments?')?[]:{title:'Make release verification handle deployment convergence and preserve precise failure evidence'};posts++;return null;};
  expect((await pollReleaseWatches(f.w.root,store,{transport,now:()=>at.getTime()+1002})).pending).toBe(1);expect(posts).toBe(1);
  expect((await pollReleaseWatches(f.w.root,store,{transport,now:()=>at.getTime()+2000})).pending).toBe(1);expect(posts).toBe(1);
  expect(await journal.read()).toEqual(history);expect(readFileSync(join(f.w.root,'latest-verified-deployment.json'))).toEqual(canonical);expect(existsSync(join(f.w.root,'deployment-lock'))).toBe(false);
 }finally{f.close();}
});
describe('independent release observation',()=>{
 it('registers once, retains the original deadline and rejects operation drift',async()=>{const f=fixture();try{expect(registerReleaseWatch({root:f.w.root,plan:f.w.plan,journalDirectory:f.w.journalDirectory,proofDirectory:f.w.proofDirectory})).toEqual(f.w);expect(listReleaseWatches(f.w.root)).toEqual([f.w]);expect(()=>registerReleaseWatch({...f.w,plan:{...f.w.plan,evidenceDigest:'c'.repeat(64)}})).toThrow('CHANGED');expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+119999))).toEqual({status:'waiting'});expect((await inspectReleaseWatch(f.w,new Date(at.getTime()+120000))).status).toBe('attention');expect(existsSync(join(f.w.root,'deployment-lock'))).toBe(false);}finally{f.close();}});
 it('alerts after actual SIGKILL without acquiring or changing the retained lease',async()=>{const f=fixture();try{
  const code=`import {FileDeploymentLease} from ${JSON.stringify(resolve('scripts/deployment-recovery-lease.ts'))};import {FileRecoveryJournal} from ${JSON.stringify(resolve('scripts/deployment-recovery-journal.ts'))};const w=${JSON.stringify(f.w)};const lease=FileDeploymentLease.acquire(w.root,w.plan);const j=new FileRecoveryJournal(w.journalDirectory);let s={v:1,revision:1,planHash:${JSON.stringify(deploymentPlanHash(f.w.plan))},phase:'prepared'};await j.write(null,s);await j.write(s,{...s,revision:2,phase:'activation-intent'});process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});expect(child.signal).toBe('SIGKILL');const owner=readFileSync(join(f.w.root,'deployment-lock/owner.json'),'utf8');const canonical=readFileSync(join(f.w.root,'latest-verified-deployment.json'),'utf8');
  const result=await inspectReleaseWatch(f.w,new Date(at.getTime()+120000));expect(result).toMatchObject({status:'attention',event:{reason:'release-overdue',operationId:id(1)}});expect(readFileSync(join(f.w.root,'deployment-lock/owner.json'),'utf8')).toBe(owner);expect(readFileSync(join(f.w.root,'latest-verified-deployment.json'),'utf8')).toBe(canonical);expect(existsSync(join(f.w.journalDirectory,'00003.json'))).toBe(false);
 }finally{f.close();}});
 it('recognizes verified historical completion without current provider access',async()=>{const f=fixture();try{const lease=FileDeploymentLease.acquire(f.w.root,f.w.plan),j=new FileRecoveryJournal(f.w.journalDirectory);let prev=null;for(const [i,phase] of ['prepared','activation-intent','candidate-observed','complete'].entries()){const next={v:1 as const,revision:i+1,planHash:deploymentPlanHash(f.w.plan),phase:phase as 'prepared'|'activation-intent'|'candidate-observed'|'complete',...(i>=2?{candidateDeploymentId:id(5)}:{})};await j.write(prev,next);prev=next;}await lease.finalize(j);await lease.release(j);expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+900000))).toEqual({status:'completed'});expect(existsSync(join(f.w.proofDirectory,'attention-'+id(1)+'.json'))).toBe(false);queueReleaseAlert(f.w.proofDirectory,f.w.plan,'release-overdue',at);expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+900001))).toEqual({status:'completed'});const original=readFileSync(join(f.w.proofDirectory,'attention-'+id(1)+'.json'));queueReleaseAlert(f.w.proofDirectory,f.w.plan,'command-failed',new Date(at.getTime()+900002));expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+900003))).toMatchObject({status:'attention',event:{reason:'release-overdue'}});expect(readFileSync(join(f.w.proofDirectory,'attention-'+id(1)+'.json'))).toEqual(original);}finally{f.close();}});
 it('keeps a late continuity failure actionable after verified finalization without changing history',async()=>{const f=fixture();try{const lease=FileDeploymentLease.acquire(f.w.root,f.w.plan),j=new FileRecoveryJournal(f.w.journalDirectory);let prev=null;for(const [i,phase] of ['prepared','activation-intent','candidate-observed','complete'].entries()){const next={v:1 as const,revision:i+1,planHash:deploymentPlanHash(f.w.plan),phase:phase as 'prepared'|'activation-intent'|'candidate-observed'|'complete',...(i>=2?{candidateDeploymentId:id(5)}:{})};await j.write(prev,next);prev=next;}await lease.finalize(j);await lease.release(j);const canonical=readFileSync(join(f.w.root,'latest-verified-deployment.json'));createContinuityGate(f.w.proofDirectory,f.w.plan).retain({kind:'sample',sample:{at:at.toISOString(),healthy:false}} as ContinuityCommandEvent);expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+900000))).toMatchObject({status:'attention',event:{reason:'command-failed'}});expect(readFileSync(join(f.w.root,'latest-verified-deployment.json'))).toEqual(canonical);expect((await j.read())?.phase).toBe('complete');}finally{f.close();}});
 it('suppresses cancelled operations using the owned cancellation archive',async()=>{const f=fixture();try{const lease=FileDeploymentLease.acquire(f.w.root,f.w.plan);await lease.cancelBeforeIntent(new FileRecoveryJournal(f.w.journalDirectory));lease.close();expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+900000))).toEqual({status:'cancelled'});}finally{f.close();}});
});

it('reconciles uncertain dispatch across restarts and persists cooldown before POST',async()=>{const f=fixture();try{
 let clock=at.getTime()+120000,posts=0;const records=new Map<string,WatchDeliveryState>(),store={read:(id:string)=>records.get(id)??null,write:(id:string,v:WatchDeliveryState)=>{records.set(id,v);}},comments:unknown[]=[];
 const transport:GitHubTransport=async(method,path)=>{if(method==='GET')return path.includes('/comments?')?comments:{title:'Make release verification handle deployment convergence and preserve precise failure evidence'};expect(records.get(id(1))?.lastAttempt).toBe(clock);posts++;throw Error('ack lost');};
 expect((await pollReleaseWatches(f.w.root,store,{transport,now:()=>clock})).errors).toBe(1);expect(posts).toBe(1);
 clock+=20000;expect((await pollReleaseWatches(f.w.root,store,{transport,now:()=>clock})).pending).toBe(1);expect(posts).toBe(1);
 const result=await inspectReleaseWatch(f.w,new Date(clock));if(result.status!=='attention')throw Error('EXPECTED_ALERT');comments.push({body:releaseAlertBody(result.event),user:{login:'github-actions[bot]',type:'Bot'}});
 expect((await pollReleaseWatches(f.w.root,store,{transport,now:()=>clock})).delivered).toBe(1);expect(records.get(id(1))?.delivered).toBe(true);expect(posts).toBe(1);
 expect((await pollReleaseWatches(f.w.root,store,{transport:async()=>{throw Error('NO_NETWORK');},now:()=>clock})).delivered).toBe(1);
 }finally{f.close();}});
it('reports a corrupt registration without suppressing valid overdue releases',async()=>{const f=fixture();try{
 writeFileSync(join(f.w.root,'release-watches','broken.json'),'{',{mode:0o600});const store={read:()=>null,write:()=>{}};
 const result=await pollReleaseWatches(f.w.root,store,{now:()=>at.getTime()+120000,transport:async(method,path)=>method==='GET'?(path.includes('/comments?')?[]:{title:'Make release verification handle deployment convergence and preserve precise failure evidence'}):null});
 expect(result.errors).toBe(1);expect(result.pending).toBe(1);
 }finally{f.close();}});
it('raises attention for unreadable intent evidence without altering it',async()=>{const f=fixture();try{
 const path=join(f.w.journalDirectory,'00001.json');writeFileSync(path,'{',{mode:0o600});expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+1000))).toEqual({status:'waiting'});
 expect(await inspectReleaseWatch(f.w,new Date(at.getTime()+120000))).toMatchObject({status:'attention',event:{reason:'release-state-unreadable'}});expect(readFileSync(path,'utf8')).toBe('{');
 }finally{f.close();}});

it('native polling command queues overdue attention and preserves it when GitHub is unavailable',()=>{const f=fixture();try{
 const child=spawnSync(process.execPath,['scripts/release-watch-cli.ts',f.w.root,'--once'],{encoding:'utf8',env:{...process.env,PORCHDAY_MONITOR_GH_PATH:'/nonexistent/porchday-test-gh'},timeout:10000});
 expect(child.status).toBe(2);expect(JSON.parse(child.stdout)).toMatchObject({errors:1});expect(existsSync(join(f.w.proofDirectory,'attention-'+id(1)+'.json'))).toBe(true);expect(existsSync(join(f.w.root,'deployment-lock'))).toBe(false);
 }finally{f.close();}});
