import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync,existsSync,writeFileSync,fsyncSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deploymentPlanHash,deploymentTarget,recoverDeployment,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {readUploadManifest} from './release-upload-cli.ts';
import {activationReviewHash,verifyActivationReview,createReviewedActivationPorts,type ActivationReviewEvidence,type ActivationExecution} from './release-activation-review.ts';
import {finalizePreparedActivation} from './release-activation-finalize.ts';
import {createReleaseVerifier} from './release-verification.ts';
import {validateProbeConfig,type ProbeConfig} from './external-monitor-probe.ts';
import {validateReleaseDatabaseTarget} from './release-schema.ts';
import {CloudflareReleaseReader} from './cloudflare-release-reader.ts';
import {registerReleaseWatch} from './release-watch.ts';
import {queueReleaseAlert,deliverReleaseAlert,type ReleaseAlert} from './release-alerts.ts';
import {CloudflareDeploymentClient} from './cloudflare-deployment-client.ts';

export type ActivationManifest={version:1;plan:DeploymentPlan;review:ActivationReviewEvidence&{execution:ActivationExecution}};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function keys(value:unknown,names:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))throw Error('ACTIVATION_MANIFEST_INVALID');}
function privateBytes(path:string){
 if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size<1||s.size>16*1024*1024)throw Error('ACTIVATION_MANIFEST_PERMISSIONS');const bytes=readFileSync(fd);if(bytes.length!==s.size)throw Error('ACTIVATION_MANIFEST_CHANGED');return bytes;}finally{closeSync(fd);}
}
function directory(path:string){if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('ACTIVATION_MANIFEST_PERMISSIONS');}
function validate(manifest:ActivationManifest){
 keys(manifest,['version','plan','review']);if(manifest.version!==1)throw Error('ACTIVATION_MANIFEST_INVALID');deploymentPlanHash(manifest.plan);
 if(activationReviewHash(manifest.review)!==manifest.plan.evidenceDigest)throw Error('ACTIVATION_MANIFEST_EVIDENCE_CHANGED');
 const e=manifest.review.execution;keys(e,['root','workspace','uploadManifest','proofPath','probe','journalDirectory','proofDirectory','journeyDirectory']);
 for(const p of [e.root,e.workspace,e.proofPath,e.journalDirectory,e.proofDirectory,e.journeyDirectory])if(typeof p!=='string'||!isAbsolute(p)||resolve(p)!==p)throw Error('ACTIVATION_MANIFEST_PATH_INVALID');
 for(const file of [e.uploadManifest,e.probe]){keys(file,['path','sha256']);if(typeof file.path!=='string'||!isAbsolute(file.path)||resolve(file.path)!==file.path||! /^[a-f0-9]{64}$/.test(file.sha256))throw Error('ACTIVATION_MANIFEST_PATH_INVALID');}
 // Journal enumeration must not overlap proofs or private sessions, nor the shared lock.
 const dirs=[e.journalDirectory,e.proofDirectory,e.journeyDirectory,join(e.root,'deployment-lock')];
 for(let i=0;i<dirs.length;i++)for(let j=i+1;j<dirs.length;j++)if(dirs[i]===dirs[j]||dirs[i].startsWith(dirs[j]+sep)||dirs[j].startsWith(dirs[i]+sep))throw Error('ACTIVATION_MANIFEST_DIRECTORY_OVERLAP');
 directory(e.root);directory(e.journalDirectory);
}
export function readActivationManifest(path:string):ActivationManifest{const manifest=JSON.parse(privateBytes(path).toString()) as ActivationManifest;validate(manifest);return manifest;}
function readPinned(file:{path:string;sha256:string}){const bytes=privateBytes(file.path);if(hash(bytes)!==file.sha256)throw Error('ACTIVATION_MANIFEST_FILE_CHANGED');return bytes;}

/** Explicit activate/resume. Archived completion and durable finalization resume need no credentials. */
export async function executeActivationManifest(input:ActivationManifest,env:NodeJS.ProcessEnv,signal:AbortSignal,action:'activate'|'cancel'='activate'){
 const manifest=structuredClone(input);validate(manifest);signal.throwIfAborted();if(!['activate','cancel'].includes(action))throw Error('ACTIVATION_ARGUMENTS');
 const {plan,review}=manifest,e=review.execution,journal=new FileRecoveryJournal(e.journalDirectory);
 if(await FileDeploymentLease.completed(e.root,plan,journal)){if(action==='cancel')throw Error('DEPLOYMENT_ALREADY_FINALIZED');return{status:'already-finalized' as const,historical:true,operationId:plan.operationId};}
 if(action==='cancel'){const lease=FileDeploymentLease.acquire(e.root,plan);try{await lease.cancelBeforeIntent(journal);return{status:'cancelled-before-intent' as const,operationId:plan.operationId};}finally{lease.close();}}
 // This is only a hint. Acquisition and receipt verification establish ownership.
 if(existsSync(join(e.root,'deployment-lock','finalization.json'))){
  const lease=FileDeploymentLease.acquire(e.root,plan);try{if(await lease.resumeFinalization(journal))return{status:'resumed-historical-finalization' as const,historical:true,operationId:plan.operationId};}finally{lease.close();}
 }
 if(e.workspace!==realpathSync(dirname(fileURLToPath(new URL('../package.json',import.meta.url)))))throw Error('ACTIVATION_TOOLING_WORKSPACE_CHANGED');
 directory(e.proofDirectory);directory(e.journeyDirectory);
 const uploadBytes=readPinned(e.uploadManifest),upload=readUploadManifest(e.uploadManifest.path);
 if(!isDeepStrictEqual(upload,JSON.parse(uploadBytes.toString())))throw Error('ACTIVATION_MANIFEST_FILE_CHANGED');
 if(upload.root!==e.root)throw Error('ACTIVATION_UPLOAD_ROOT_CHANGED');
 const config=JSON.parse(readPinned(e.probe).toString()) as ProbeConfig;validateProbeConfig(config);
 const target=deploymentTarget(plan.worker);if(config.environment!==target.environment)throw Error('ACTIVATION_PROBE_SCOPE_CHANGED');
 verifyActivationReview(plan,upload,e.proofPath,review);
 const accountId=env.CLOUDFLARE_ACCOUNT_ID??'',apiToken=env.CLOUDFLARE_API_TOKEN??'',connection=env[target.environment==='staging'?'PORCHDAY_STAGING_DATABASE_MIGRATION_URL':'PORCHDAY_PRODUCTION_DATABASE_MIGRATION_URL']??'';
 const database={connection,branchId:upload.evidence.databaseBranchId};validateReleaseDatabaseTarget(connection,database.branchId);
 const reader=new CloudflareReleaseReader({accountId,apiToken,queues:upload.queues}),client=new CloudflareDeploymentClient({accountId,apiToken,worker:plan.worker});
 const lease=FileDeploymentLease.acquire(e.root,plan);
 try{
  if(await lease.resumeFinalization(journal))return{status:'resumed-historical-finalization' as const,historical:true,operationId:plan.operationId};
  const common={workspace:e.workspace,plan,manifest:upload,proofPath:e.proofPath,review,lease,journal,reader,database};
  const final=()=>finalizePreparedActivation({...common,client,directory:e.proofDirectory},signal);
  const state=await journal.read();if(state&&['complete','rolled-back'].includes(state.phase))return await final();
  const verify=createReleaseVerifier({plan,config,assets:review.assets,directory:e.proofDirectory,journey:{directory:e.journeyDirectory,assertLease:s=>{lease.assert(plan,s);}}});
  const ports=createReviewedActivationPorts({...common,ports:{observe:s=>client.observe(s),deploy:(v,id,s)=>client.deploy(v,id,s),verify}});
  const combine=(s:AbortSignal)=>AbortSignal.any([signal,s]);
  const bounded:DeploymentPorts={authorize:(p,d,s)=>ports.authorize(p,d,combine(s)),observe:s=>ports.observe(combine(s)),deploy:(v,id,s)=>ports.deploy(v,id,combine(s)),verify:(v,s)=>ports.verify(v,combine(s))};
  const outcome=await recoverDeployment(plan,journal,bounded);
  if(!['complete','rolled-back'].includes(outcome))return{status:'attention-required' as const,outcome,operationId:plan.operationId};
  return await final();
 }finally{lease.close();}
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
  const [action,path,...extra]=process.argv.slice(2);if(!['activate','cancel'].includes(action)||!path||extra.length)throw Error('ACTIVATION_ARGUMENTS');
  manifest=readActivationManifest(path);
  if(action==='activate')registerReleaseWatch({plan:manifest.plan,root:manifest.review.execution.root,journalDirectory:manifest.review.execution.journalDirectory,proofDirectory:manifest.review.execution.proofDirectory});
  const result=await executeActivationManifest(manifest,process.env,AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]),action as 'activate'|'cancel');
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
