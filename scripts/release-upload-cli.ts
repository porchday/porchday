import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {FileUploadLease,uploadPlanHash,type UploadPlan} from './release-upload-lease.ts';
import {runPreparedUpload,type PreparedUploadEvidence} from './release-upload.ts';
import {uploadReconciliationEvidenceHash} from './release-upload-reconcile.ts';
import {CloudflareReleaseReader,type ReleaseQueues,validateReleaseQueues} from './cloudflare-release-reader.ts';
import {deploymentTarget} from './deployment-recovery.ts';
import {validateReleaseDatabaseTarget} from './release-schema.ts';

export type UploadManifest={version:1;root:string;workspace:string;proofDirectory:string;privateLogDirectory:string;plan:UploadPlan;evidence:PreparedUploadEvidence;queues:ReleaseQueues};
export function readUploadManifest(path:string):UploadManifest{
 const s=lstatSync(path);
 if(!isAbsolute(path)||realpathSync(path)!==path||!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16*1024*1024)throw Error('UPLOAD_MANIFEST_INVALID');
 const value=JSON.parse(readFileSync(path,'utf8')) as UploadManifest;
 if(!value||value.version!==1||Object.keys(value).sort().join(',')!=='evidence,plan,privateLogDirectory,proofDirectory,queues,root,version,workspace')throw Error('UPLOAD_MANIFEST_INVALID');
 for(const directory of [value.root,value.workspace,value.proofDirectory,value.privateLogDirectory])if(typeof directory!=='string'||!isAbsolute(directory)||realpathSync(directory)!==directory||!lstatSync(directory).isDirectory())throw Error('UPLOAD_MANIFEST_PATH_INVALID');
 uploadPlanHash(value.plan);
 validateReleaseQueues(value.queues);
 if(!value.evidence?.preparation||value.plan.worker!==value.evidence.worker||value.plan.source!==value.evidence.source||value.plan.evidenceDigest!==uploadReconciliationEvidenceHash(value.evidence))throw Error('UPLOAD_MANIFEST_EVIDENCE_CHANGED');
 return value;
}
/** Explicit upload/resume or no-intent cancellation. Never activates a version. */
export async function executeUploadManifest(manifest:UploadManifest,action:'upload'|'cancel',env:NodeJS.ProcessEnv,signal:AbortSignal){
 signal.throwIfAborted();if(!['upload','cancel'].includes(action))throw Error('UPLOAD_ARGUMENTS');
 const completed=FileUploadLease.completed(manifest.root,manifest.plan);
 if(completed){if(action==='cancel')throw Error('UPLOAD_ALREADY_COMPLETED');return{status:'already-verified',...completed};}
 if(action==='cancel'){
  const lease=FileUploadLease.acquire(manifest.root,manifest.plan);
  try{lease.cancelBeforeDispatch();return{status:'cancelled-before-dispatch',operationId:manifest.plan.operationId};}finally{lease.close();}
 }
 if(manifest.workspace!==realpathSync(dirname(fileURLToPath(new URL('../package.json',import.meta.url)))))throw Error('UPLOAD_TOOLING_WORKSPACE_CHANGED');
 const environment=deploymentTarget(manifest.plan.worker).environment;
 const accountId=env.CLOUDFLARE_ACCOUNT_ID??'',apiToken=env.CLOUDFLARE_API_TOKEN??'',connection=env[environment==='staging'?'PORCHDAY_STAGING_DATABASE_MIGRATION_URL':'PORCHDAY_PRODUCTION_DATABASE_MIGRATION_URL']??'';
 validateReleaseDatabaseTarget(connection,manifest.evidence.databaseBranchId);
 const reader=new CloudflareReleaseReader({accountId,apiToken,queues:manifest.queues});
 const lease=FileUploadLease.acquire(manifest.root,manifest.plan);
 try{return{status:'verified-inactive',...await runPreparedUpload({...manifest,lease,reader,accountId,apiToken,database:{connection,branchId:manifest.evidence.databaseBranchId}},signal)};}
 finally{lease.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const [action,path,...extra]=process.argv.slice(2);
  if(!['upload','cancel'].includes(action)||!path||extra.length)throw Error('UPLOAD_ARGUMENTS');
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]);
  console.log(JSON.stringify(await executeUploadManifest(readUploadManifest(path),action as 'upload'|'cancel',process.env,signal)));
 }catch{console.error('RELEASE_UPLOAD_FAILED: preserve the manifest and inspect private evidence; never repeat an uncertain write under a new operation ID.');process.exitCode=1;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
