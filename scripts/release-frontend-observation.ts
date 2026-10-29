import {createBrowserGate} from './release-browser-gate.ts';
import {constants,openSync,closeSync,fsyncSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {readActivationManifest,executeActivationWithContinuity} from './release-activation-cli.ts';
import {deploymentPlanHash,deploymentTarget} from './deployment-recovery.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {beginHostedAssetTransition} from './release-assets-hosted.ts';
import {queueReleaseAlert} from './release-alerts.ts';
import {createContinuityGate} from './release-continuity-gate.ts';

/** Frontend releases use the maintained durable controller exactly once, with
 * browser preparation before dispatch and durable candidate browser acceptance
 * inside verification, before completion and compatible rollback decisions.
 */
export async function executeFrontendActivationWithClients(path:string,env:NodeJS.ProcessEnv,
 observation:Parameters<typeof executeActivationWithContinuity>[2],signal:AbortSignal){
 return executeObservedActivation(path,env,observation,signal,true);
}
/** Covers both edge frontends and application workers that serve web assets.
 * API-only releases retain their normal authenticated continuity entry point. */
export async function executeApplicationActivationWithClients(path:string,env:NodeJS.ProcessEnv,
 observation:Parameters<typeof executeActivationWithContinuity>[2],signal:AbortSignal){
 return executeObservedActivation(path,env,observation,signal,false);
}
async function executeObservedActivation(path:string,env:NodeJS.ProcessEnv,
 observation:Parameters<typeof executeActivationWithContinuity>[2],signal:AbortSignal,frontendOnly:boolean){
 signal.throwIfAborted();const manifest=readActivationManifest(path),target=deploymentTarget(manifest.plan.worker),{plan,review}=manifest,e=review.execution;
 if(frontendOnly&&!target.frontend)throw Error('FRONTEND_OBSERVATION_TARGET_REQUIRED');
 if(!frontendOnly&&(!review.assets.baseline.files['index.html']||!review.assets.candidate.files['index.html']))throw Error('APPLICATION_OBSERVATION_ASSETS_REQUIRED');
 if(!frontendOnly&&!plan.assetManifests)throw Error('APPLICATION_OBSERVATION_ASSET_PINS_REQUIRED');
 if(observation.target.environment!==target.environment)throw Error('FRONTEND_OBSERVATION_SCOPE_CHANGED');
 const planHash=deploymentPlanHash(plan),journal=new FileRecoveryJournal(e.journalDirectory),state=await journal.read();
 if(state&&(state.phase!=='prepared'||state.planHash!==planHash)||await FileDeploymentLease.completed(e.root,plan,{read:async()=>state,write:async()=>{throw Error('FRONTEND_OBSERVATION_READ_ONLY');}}))throw Error('FRONTEND_OBSERVATION_REQUIRES_RECONCILIATION');
 createContinuityGate(e.proofDirectory,plan).assertPromotion();
 const stat=lstatSync(e.proofDirectory);
 if(!isAbsolute(e.proofDirectory)||realpathSync(e.proofDirectory)!==e.proofDirectory||!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('FRONTEND_OBSERVATION_DIRECTORY_INVALID');
 const retain=(kind:string,value:unknown)=>{
  const fd=openSync(join(e.proofDirectory,`frontend-${plan.operationId}-${kind}.json`),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify({v:1,at:new Date().toISOString(),operationId:plan.operationId,planHash,value})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(e.proofDirectory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 };
 // Existing intent is never overwritten, including after a pre-dispatch failure.
 retain('intent',{candidateVersion:plan.candidateVersion,baselineVersion:plan.baselineVersion});
 createBrowserGate(e.proofDirectory,plan).require();
 let browser:Awaited<ReturnType<typeof beginHostedAssetTransition>>|undefined;
 let browserStarted=false,report:Awaited<ReturnType<Awaited<ReturnType<typeof beginHostedAssetTransition>>['finish']>>|undefined;
 let phase:'before-command'|'command-started'|'command-returned'='before-command';
 try{
  browser=await beginHostedAssetTransition({origin:target.environment==='staging'?'https://staging.porchday.com':'https://porchday.org',baseline:review.assets.baseline,candidate:review.assets.candidate,signal});
  retain('baseline',browser.baselineReceipt);signal.throwIfAborted();
  retain('command-intent',{automaticRetry:false});phase='command-started';
  const command=await executeActivationWithContinuity(manifest,env,{...observation,assertScope:()=>{if(!browserStarted)browser!.assertOpen();observation.assertScope();}},signal,async candidateSignal=>{
   browserStarted=true;const cancel=()=>{void browser!.close().catch(()=>{});};candidateSignal.addEventListener('abort',cancel,{once:true});
   try{candidateSignal.throwIfAborted();report=await browser!.finish();candidateSignal.throwIfAborted();retain('browser-result',report);return report.passed?'healthy':'unhealthy';}
   finally{candidateSignal.removeEventListener('abort',cancel);}
  });phase='command-returned';retain('command-result',command);
  if(command.status!=='complete')throw Error('FRONTEND_OBSERVATION_CANDIDATE_NOT_COMPLETE');
  if(!report?.passed)throw Error('FRONTEND_OBSERVATION_BROWSER_FAILED');
  return{command,browser:report};
 }catch{
  // Only a fixed disposition is retained. Provider/browser exceptions may contain
  // URLs or request details; the original controller retains its own diagnostics.
  try{retain('attention',{phase,code:'FRONTEND_OBSERVATION_UNVERIFIED',automaticRetry:false});}finally{queueReleaseAlert(e.proofDirectory,plan,'command-failed');}
  throw Error('FRONTEND_OBSERVATION_UNVERIFIED');
 }finally{
  try{await browser?.close();}catch{
   try{retain('close-failure',{code:'FRONTEND_OBSERVATION_CLOSE_UNVERIFIED'});}finally{queueReleaseAlert(e.proofDirectory,plan,'command-failed');}
   throw Error('FRONTEND_OBSERVATION_CLOSE_UNVERIFIED');
  }
 }
}
