import {runPlacementTrial,type PlacementTrialCollector} from './placement-trial-runner.mjs';
import {validateTrialBaseline} from './placement-trial.mjs';
import {FileRoutingJournal} from './domain-routing-journal.ts';
import {CloudflareDomainClient} from './cloudflare-domain-client.ts';
import {leasedRoutingPorts} from './release-routing-ports.ts';
import {withRoutingRecovery} from './release-routing-controller.ts';
import {readCompletedUpload,assertActivationInventory} from './release-activation-evidence.ts';
import {withStagingInflightProbe,assertStagingInflightProbeComplete,type StagingInflightProbe} from './release-inflight-probe.ts';
import {withBrowserAcceptance,type BrowserAcceptance} from './release-browser-gate.ts';
import {createContinuityGate} from './release-continuity-gate.ts';
import {waitForMonitorRecovery} from './release-monitor-recovery-wait.ts';
import {verifyMonitorRead} from './release-monitor-verification.ts';
import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync,existsSync,writeFileSync,fsyncSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deploymentPlanHash,deploymentTarget,recoveryTarget,recoverDeployment,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {readUploadManifest} from './release-upload-cli.ts';
import {activationReviewHash,verifyActivationReview,readPlacementTrialReview,createReviewedActivationPorts,type ActivationReviewEvidence,type ActivationExecution} from './release-activation-review.ts';
import {finalizePreparedActivation} from './release-activation-finalize.ts';
import {createReleaseVerifier} from './release-verification.ts';
import {validateProbeConfig,type ProbeConfig} from './external-monitor-probe.ts';
import {validateReleaseDatabaseTarget} from './release-schema.ts';
import {CloudflareReleaseReader} from './cloudflare-release-reader.ts';
import {registerReleaseWatch} from './release-watch.ts';
import {queueReleaseAlert,deliverReleaseAlert,type ReleaseAlert} from './release-alerts.ts';
import {CloudflareDeploymentClient} from './cloudflare-deployment-client.ts';
import {verifyReleaseProbeFixture,withReleaseProbePreflight} from './release-probe-preflight.ts';
import {runCommandWithContinuity} from './release-continuity-command.ts';

export type ActivationManifest={version:1;plan:DeploymentPlan;review:ActivationReviewEvidence&{execution:ActivationExecution}};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function keys(value:unknown,names:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))throw Error('ACTIVATION_MANIFEST_INVALID');}
function privateBytes(path:string){
 if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size<1||s.size>16*1024*1024)throw Error('ACTIVATION_MANIFEST_PERMISSIONS');const bytes=readFileSync(fd);if(bytes.length!==s.size)throw Error('ACTIVATION_MANIFEST_CHANGED');return bytes;}finally{closeSync(fd);}
}
function directory(path:string){if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('ACTIVATION_MANIFEST_PERMISSIONS');}
function validate(manifest:ActivationManifest,monitor=false){
 keys(manifest,['version','plan','review']);if(monitor){if(!recoveryTarget(manifest.plan.worker).monitor)throw Error('ACTIVATION_MONITOR_TARGET_REQUIRED');}else deploymentTarget(manifest.plan.worker);if(manifest.version!==1)throw Error('ACTIVATION_MANIFEST_INVALID');deploymentPlanHash(manifest.plan);
 if(activationReviewHash(manifest.review)!==manifest.plan.evidenceDigest)throw Error('ACTIVATION_MANIFEST_EVIDENCE_CHANGED');
 const e=manifest.review.execution;keys(e,['root','workspace','uploadManifest','proofPath','probe','journalDirectory','proofDirectory','journeyDirectory']);
 for(const p of [e.root,e.workspace,e.proofPath,e.journalDirectory,e.proofDirectory,e.journeyDirectory])if(typeof p!=='string'||!isAbsolute(p)||resolve(p)!==p)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');
 for(const file of [e.uploadManifest,e.probe]){keys(file,['path','sha256']);if(typeof file.path!=='string'||!isAbsolute(file.path)||resolve(file.path)!==file.path||! /^[a-f0-9]{64}$/.test(file.sha256))throw Error('ACTIVATION_MANIFEST_PATH_INVALID');}
 // Journal enumeration must not overlap proofs or private sessions, nor the shared lock.
 const dirs=[...(manifest.review.placementTrial?[manifest.review.placementTrial.journalDirectory]:[]),e.journalDirectory,...(manifest.plan.routing?[e.journalDirectory+'.routing']:[]),e.proofDirectory,e.journeyDirectory,join(e.root,'deployment-lock')];
 for(let i=0;i<dirs.length;i++)for(let j=i+1;j<dirs.length;j++)if(dirs[i]===dirs[j]||dirs[i].startsWith(dirs[j]+sep)||dirs[j].startsWith(dirs[i]+sep))throw Error('ACTIVATION_MANIFEST_DIRECTORY_OVERLAP');
 directory(e.root);directory(e.journalDirectory);
}
export function readMonitorActivationManifest(path:string):ActivationManifest{const manifest=JSON.parse(privateBytes(path).toString()) as ActivationManifest;validate(manifest,true);return manifest;}
export function readActivationManifest(path:string):ActivationManifest{const manifest=JSON.parse(privateBytes(path).toString()) as ActivationManifest;validate(manifest);return manifest;}
function readPinned(file:{path:string;sha256:string}){const bytes=privateBytes(file.path);if(hash(bytes)!==file.sha256)throw Error('ACTIVATION_MANIFEST_FILE_CHANGED');return bytes;}

/** Reject incompatible canonical plans before a caller creates private fixtures.
 * This performs local reads only and grants no deployment authorization.
 * Historical operations must use the explicit reconciliation entry point.
 */
export async function prepareActivationFixtures<T>(input:ActivationManifest,prepare:()=>Promise<T>):Promise<T>{
 const manifest=structuredClone(input);validate(manifest,recoveryTarget(manifest.plan.worker).monitor);
 const state=await new FileRecoveryJournal(manifest.review.execution.journalDirectory).read();
 if(state&&(state.phase!=='prepared'||state.planHash!==deploymentPlanHash(manifest.plan)))throw Error('ACTIVATION_CONTINUITY_REQUIRES_RECONCILIATION');
 FileDeploymentLease.preflight(manifest.review.execution.root,manifest.plan);
 return await prepare();
}

/** New observed activation using the real durable command, not an arbitrary
 * mutation callback. The harness owns pinned fixtures, durable sample retention
 * and scope checks spanning lease handoff/finalization. Resuming a historical
 * operation cannot manufacture a fresh observed release acceptance. */
async function executeScopedActivationWithContinuity(
 monitor:boolean,input:ActivationManifest,env:NodeJS.ProcessEnv,
 observation:Omit<Parameters<typeof runCommandWithContinuity>[0],'runCommand'>,
 signal:AbortSignal,browserAcceptance?:BrowserAcceptance,inflightProbe?:StagingInflightProbe,trialCollector?:PlacementTrialCollector,
){
 signal.throwIfAborted();const manifest=structuredClone(input);validate(manifest,monitor);
 if(inflightProbe&&(monitor||manifest.plan.worker!=='porchday-staging'||manifest.plan.assetManifests||!browserAcceptance||!isDeepStrictEqual(manifest.review.assets.baseline,manifest.review.assets.candidate)||typeof inflightProbe.start!=='function'||typeof inflightProbe.finish!=='function'))throw Error('STAGING_INFLIGHT_SCOPE_INVALID');
 if(observation.target.environment!==recoveryTarget(manifest.plan.worker).environment)throw Error('ACTIVATION_CONTINUITY_SCOPE_CHANGED');
 const e=manifest.review.execution;
 // Reject history before network reads; use the existing explicit reconciliation
 // entry point for interrupted operations and preserve their original evidence.
 const state=await new FileRecoveryJournal(e.journalDirectory).read();
 if(state&&(state.phase!=='prepared'||state.planHash!==deploymentPlanHash(manifest.plan))||await FileDeploymentLease.completed(e.root,manifest.plan,{read:async()=>state,write:async()=>{throw Error('ACTIVATION_CONTINUITY_READ_ONLY');}}))throw Error('ACTIVATION_CONTINUITY_REQUIRES_RECONCILIATION');
 FileDeploymentLease.preflight(e.root,manifest.plan);
 registerReleaseWatch({plan:manifest.plan,root:e.root,journalDirectory:e.journalDirectory,proofDirectory:e.proofDirectory});
 const gate=createContinuityGate(e.proofDirectory,manifest.plan);gate.assertPromotion();
 return await runCommandWithContinuity({...observation,placementTrial:manifest.plan.placementTrial,retain:async event=>{
  // Persist the stop decision before yielding to the caller's evidence sink.
  gate.retain(event);
  if(event.kind==='sample'&&!event.sample.healthy)queueReleaseAlert(e.proofDirectory,manifest.plan,'command-failed');
  await observation.retain(event);
 },runCommand:async commandSignal=>{
  const result=await executeScopedActivationManifest(manifest,env,commandSignal,monitor,'activate',browserAcceptance,inflightProbe,trialCollector);
  if(result.status==='finalized'&&(result.outcome==='complete'||result.outcome==='rolled-back'))return result.outcome;
  return 'attention-required';
 }},signal);
}

export async function executeActivationWithContinuity(input:ActivationManifest,env:NodeJS.ProcessEnv,observation:Omit<Parameters<typeof runCommandWithContinuity>[0],'runCommand'>,signal:AbortSignal,browserAcceptance?:BrowserAcceptance,inflightProbe?:StagingInflightProbe,trialCollector?:PlacementTrialCollector){
 return executeScopedActivationWithContinuity(false,input,env,observation,signal,browserAcceptance,inflightProbe,trialCollector);
}
export async function executeMonitorActivationWithContinuity(input:ActivationManifest,env:NodeJS.ProcessEnv,observation:Omit<Parameters<typeof runCommandWithContinuity>[0],'runCommand'>,signal:AbortSignal){
 return executeScopedActivationWithContinuity(true,input,env,observation,signal);
}

/** Explicit activate/resume. Archived completion and durable finalization resume need no credentials. */
async function executeScopedActivationManifest(input:ActivationManifest,env:NodeJS.ProcessEnv,signal:AbortSignal,monitor:boolean,action:'activate'|'cancel'='activate',browserAcceptance?:BrowserAcceptance,inflightProbe?:StagingInflightProbe,trialCollector?:PlacementTrialCollector){
 const manifest=structuredClone(input);validate(manifest,monitor);signal.throwIfAborted();if(!['activate','cancel'].includes(action))throw Error('ACTIVATION_ARGUMENTS');
 const {plan,review}=manifest,e=review.execution,journal=new FileRecoveryJournal(e.journalDirectory),gate=createContinuityGate(e.proofDirectory,plan);
 if(inflightProbe&&(monitor||plan.worker!=='porchday-staging'||plan.assetManifests||!browserAcceptance||!isDeepStrictEqual(review.assets.baseline,review.assets.candidate)||typeof inflightProbe.start!=='function'||typeof inflightProbe.finish!=='function'))throw Error('STAGING_INFLIGHT_SCOPE_INVALID');
 assertStagingInflightProbeComplete(plan,e.proofDirectory);
 if(await FileDeploymentLease.completed(e.root,plan,journal)){if(action==='cancel')throw Error('DEPLOYMENT_ALREADY_FINALIZED');if((await journal.read())?.phase==='complete')gate.assertPromotion();return{status:'already-finalized' as const,historical:true,operationId:plan.operationId};}
 if(action==='cancel'){const lease=FileDeploymentLease.acquire(e.root,plan);try{await lease.cancelBeforeIntent(journal);return{status:'cancelled-before-intent' as const,operationId:plan.operationId};}finally{lease.close();}}
 // This is only a hint. Acquisition and receipt verification establish ownership.
 if(existsSync(join(e.root,'deployment-lock','finalization.json'))){
  const lease=FileDeploymentLease.acquire(e.root,plan);try{if(await lease.resumeFinalization(journal)){if((await journal.read())?.phase==='complete')gate.assertPromotion();return{status:'resumed-historical-finalization' as const,historical:true,operationId:plan.operationId};}}finally{lease.close();}
 }
 if(e.workspace!==realpathSync(dirname(fileURLToPath(new URL('../package.json',import.meta.url)))))throw Error('ACTIVATION_TOOLING_WORKSPACE_CHANGED');
 if(plan.placementTrial&&!trialCollector)throw Error('ACTIVATION_TRIAL_COLLECTOR_REQUIRED');
 if(trialCollector&&!plan.placementTrial)throw Error('ACTIVATION_TRIAL_SCOPE_INVALID');
 if(plan.placementTrial&&[undefined,'prepared'].includes((await journal.read())?.phase))validateTrialBaseline(readPlacementTrialReview(plan,review),Date.now());
 directory(e.proofDirectory);directory(e.journeyDirectory);
 const uploadBytes=readPinned(e.uploadManifest),upload=readUploadManifest(e.uploadManifest.path);
 if(!isDeepStrictEqual(upload,JSON.parse(uploadBytes.toString())))throw Error('ACTIVATION_MANIFEST_FILE_CHANGED');
 if(upload.root!==e.root)throw Error('ACTIVATION_UPLOAD_ROOT_CHANGED');
 const config=JSON.parse(readPinned(e.probe).toString()) as ProbeConfig;validateProbeConfig(config);
 const target=recoveryTarget(plan.worker);if(config.environment!==target.environment)throw Error('ACTIVATION_PROBE_SCOPE_CHANGED');
 verifyActivationReview(plan,upload,e.proofPath,review);
 const accountId=env.CLOUDFLARE_ACCOUNT_ID??'',apiToken=env.CLOUDFLARE_API_TOKEN??'',connection=env[target.environment==='staging'?'PORCHDAY_STAGING_DATABASE_MIGRATION_URL':'PORCHDAY_PRODUCTION_DATABASE_MIGRATION_URL']??'';
 const database={connection,branchId:upload.evidence.databaseBranchId};validateReleaseDatabaseTarget(connection,database.branchId);
 const reader=new CloudflareReleaseReader({accountId,apiToken,queues:upload.queues}),client=new CloudflareDeploymentClient({accountId,apiToken,worker:plan.worker});
 const lease=FileDeploymentLease.acquire(e.root,plan);
 try{
  if(await lease.resumeFinalization(journal)){if((await journal.read())?.phase==='complete')gate.assertPromotion();return{status:'resumed-historical-finalization' as const,historical:true,operationId:plan.operationId};}
  const routingJournal=plan.routing?new FileRoutingJournal(e.journalDirectory+'.routing',plan.routing):undefined;
  const domains=plan.routing?new CloudflareDomainClient({accountId,apiToken,plan:plan.routing}):undefined;
  const routingProgress=async()=>{
   const state=await routingJournal!.read();let count=state?.completed??0;
   if(state?.intent){const forward=state.direction==='forward',move=plan.routing!.moves[forward?count:count-1];if(!move)throw Error('ROUTING_PROGRESS_INVALID');const actual=await domains!.observe(move.before.hostname);if(actual.service===(forward?move.after:move.before).service)count+=forward?1:-1;}
   return count;
  };
  const common={workspace:e.workspace,plan,manifest:upload,proofPath:e.proofPath,review,lease,journal,reader,database,...(plan.routing?{routingProgress}:{})};
  const final=async()=>{const probeDeployment=assertStagingInflightProbeComplete(plan,e.proofDirectory,!!inflightProbe);if(probeDeployment&&(await journal.read())?.rollbackDeploymentId!==probeDeployment)throw Error('STAGING_INFLIGHT_DEPLOYMENT_CHANGED');return finalizePreparedActivation({...common,client,directory:e.proofDirectory},signal);};
  const state=await journal.read();if(state&&['complete','rolled-back'].includes(state.phase))return await final();
  const verify=createReleaseVerifier({plan,config,assets:review.assets,directory:e.proofDirectory,journey:{directory:e.journeyDirectory,assertLease:s=>{lease.assert(plan,s);}}});
  const incidentRecovery=monitor&&review.monitor?.incidentRecovery!==undefined;
  const monitoredVerify:DeploymentPorts['verify']=async(v,s)=>{if(incidentRecovery&&v===plan.candidateVersion&&!await waitForMonitorRecovery({plan,review,version:v,directory:e.proofDirectory,assertScope:()=>{lease.assert(plan,s);}},s))return 'unhealthy';const result=await verify(v,s);if(result==='healthy'&&monitor)await verifyMonitorRead({plan,review,version:v,directory:e.proofDirectory,assertScope:()=>{lease.assert(plan,s);}},s);return result;};
  const reviewed=createReviewedActivationPorts({...common,ports:{observe:s=>client.observe(s),deploy:(v,id,s)=>{if(v===plan.candidateVersion)gate.assertPromotion();return client.deploy(v,id,s);},verify:withBrowserAcceptance(plan,e.proofDirectory,monitoredVerify,browserAcceptance)}});
  const authorized:DeploymentPorts={...reviewed,authorize:async(p,d,s)=>{await reviewed.authorize(p,d,s);if(monitor&&d==='activate')await verifyMonitorRead({plan,review,version:plan.baselineVersion,phase:'before-activation',directory:e.proofDirectory,assertScope:()=>{lease.assert(plan,s);}},s);}};
  const routed=plan.routing?withRoutingRecovery(plan,authorized,leasedRoutingPorts({plan,lease,deploymentJournal:journal,routingJournal:routingJournal!,provider:domains!,signal,observeDeployment:s=>client.observe(s),verifyInventory:async(count,s)=>{const completed=readCompletedUpload(upload,e.proofPath);const snapshot=await reader.snapshot(s);lease.assert(plan,s);assertActivationInventory(completed,plan,plan.candidateVersion,snapshot,count);}})):authorized;
  const checked=withReleaseProbePreflight(routed,s=>verifyReleaseProbeFixture({...database,config,signal:s}));
  const ports=inflightProbe?withStagingInflightProbe({...inflightProbe,plan,ports:checked,proofDirectory:e.proofDirectory,assertScope:()=>{lease.assert(plan,signal);}},signal):checked;
  const combine=(s:AbortSignal)=>AbortSignal.any([signal,s]);
  const trial=plan.placementTrial?async(s:AbortSignal)=>{try{return await runPlacementTrial({directory:review.placementTrial!.journalDirectory,operationId:plan.operationId,baseline:readPlacementTrialReview(plan,review),assertLease:()=>{lease.assert(plan,s);gate.assertPromotion();},assertInventory:async checkSignal=>{const completed=readCompletedUpload(upload,e.proofPath);assertActivationInventory(completed,plan,plan.candidateVersion,await reader.snapshot(checkSignal));},collect:trialCollector!,signal:combine(s)});}catch(error){if(error instanceof Error&&error.message==='TRIAL_BASELINE_STALE')return 'unhealthy' as const;throw error;}}:undefined;
  const bounded:DeploymentPorts={...(trial?{trial}:{}),authorize:(p,d,s)=>ports.authorize(p,d,combine(s)),observe:s=>ports.observe(combine(s)),deploy:(v,id,s)=>ports.deploy(v,id,combine(s)),verify:(v,s)=>ports.verify(v,combine(s))};
  const outcome=await recoverDeployment(plan,journal,bounded,{...(incidentRecovery?{monitorRecoveryObservation:true}:{}),promotionAllowed:()=>!gate.failed()});
  if(!['complete','rolled-back'].includes(outcome))return{status:'attention-required' as const,outcome,operationId:plan.operationId};
  return await final();
 }finally{lease.close();}
}
/** Explicit continuation of an already dispatched trial. It cannot create a
 * new activation or reset its original observation journal after interruption. */
export async function resumePlacementTrialManifest(input:ActivationManifest,env:NodeJS.ProcessEnv,signal:AbortSignal,collector:PlacementTrialCollector){
 const manifest=structuredClone(input);validate(manifest);
 if(!manifest.plan.placementTrial)throw Error('ACTIVATION_TRIAL_SCOPE_INVALID');
 const state=await new FileRecoveryJournal(manifest.review.execution.journalDirectory).read();
 if(!state||state.phase==='prepared'||state.planHash!==deploymentPlanHash(manifest.plan))throw Error('ACTIVATION_TRIAL_NOT_DISPATCHED');
 return executeScopedActivationManifest(manifest,env,signal,false,'activate',undefined,undefined,collector);
}
export async function executeActivationManifest(input:ActivationManifest,env:NodeJS.ProcessEnv,signal:AbortSignal,action:'activate'|'cancel'='activate'){
 return executeScopedActivationManifest(input,env,signal,false,action);
}
/** Explicit monitor entry point; retains all application journey, CI, schema,
 * inventory and lease gates and additionally requires monitor state evidence. */
export async function executeMonitorActivationManifest(input:ActivationManifest,env:NodeJS.ProcessEnv,signal:AbortSignal,action:'activate'|'cancel'='activate'){
 return executeScopedActivationManifest(input,env,signal,true,action);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let manifest:ActivationManifest|undefined;
 const alert=async(reason:ReleaseAlert['reason'])=>{
  if(!manifest)return;
  try{const event=queueReleaseAlert(manifest.review.execution.proofDirectory,manifest.plan,reason);
   try{const status=await deliverReleaseAlert(event);console.error('RELEASE_OWNER_NOTIFICATION_'+status.toUpperCase());}catch{console.error('RELEASE_OWNER_NOTIFICATION_PENDING');}
  }catch{console.error('RELEASE_OWNER_NOTIFICATION_NOT_QUEUED');}
 };
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const [action,path,...extra]=process.argv.slice(2);if(!['activate','cancel','activate-monitor','cancel-monitor'].includes(action)||!path||extra.length)throw Error('ACTIVATION_ARGUMENTS');
  const monitor=action.endsWith('-monitor'),operation=action.startsWith('activate')?'activate':'cancel';
  manifest=monitor?readMonitorActivationManifest(path):readActivationManifest(path);
  if(operation==='activate')registerReleaseWatch({plan:manifest.plan,root:manifest.review.execution.root,journalDirectory:manifest.review.execution.journalDirectory,proofDirectory:manifest.review.execution.proofDirectory});
  const execute=monitor?executeMonitorActivationManifest:executeActivationManifest;
  const result=await execute(manifest,process.env,AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]),operation);
  console.log(JSON.stringify(result));if(result.status==='attention-required'){process.exitCode=2;await alert(result.outcome as ReleaseAlert['reason']);}
 }catch(error){
  // Retain only a fixed code and operation identity, never raw exception text.
  if(manifest)try{
   const directoryPath=manifest.review.execution.proofDirectory;directory(directoryPath);
   const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.message)?error.message:'ACTIVATION_UNCLASSIFIED_FAILURE';
   const fd=openSync(join(directoryPath,'failure-'+randomUUID()+'.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),operationId:manifest.plan.operationId,planHash:deploymentPlanHash(manifest.plan),code})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
   const parent=openSync(directoryPath,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
  }catch{/* Preserve the fixed console error even when evidence storage failed. */}
  await alert('command-failed');
  console.error('RELEASE_ACTIVATION_FAILED: retain the exact manifest, journal and private session evidence; inspect before resuming. Never replace an uncertain operation with a new ID.');process.exitCode=1;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
