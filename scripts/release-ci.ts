import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
const repository='porchday/porchday';
const workflows={verify:{path:'.github/workflows/ci.yml',job:'verify'},history:{path:'.github/workflows/secret-scan.yml',job:'history'}};
export type ReleaseCiPin={runId:number;attempt:number;workflowSha256:string};
export type ReleaseCiReader=(path:string,signal:AbortSignal)=>Promise<unknown>;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('RELEASE_CI_RESPONSE_INVALID');return value as Record<string,unknown>;}
function command(binary:string,args:string[],workspace:string,signal:AbortSignal):Promise<Buffer>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>execFile(binary,args,{cwd:workspace,encoding:'buffer',timeout:10000,maxBuffer:2*1024*1024,signal},(error,stdout)=>error?reject(Error('RELEASE_CI_READ_FAILED')):resolve(stdout)));
}
/** Read-only GitHub API via the existing authenticated CLI. No dispatch/rerun API is exposed. */
export function githubReleaseCiReader(workspace:string):ReleaseCiReader{
 if(!isAbsolute(workspace))throw Error('RELEASE_CI_WORKSPACE_INVALID');
 return async(path,signal)=>{
  if(!/^repos\/porchday\/porchday\/actions\/runs\/\d+(\/attempts\/\d+\/jobs\?per_page=100)?$/.test(path))throw Error('RELEASE_CI_PATH_INVALID');
  const bytes=await command('gh',['api','--hostname','github.com','--method','GET',path],workspace,signal);
  try{return JSON.parse(bytes.toString());}catch{throw Error('RELEASE_CI_RESPONSE_INVALID');}
 };
}
/** Workflow hashes are reviewed policy inputs, not values learned from a candidate's passing run. */
export async function verifyReleaseCi(options:{workspace:string;source:string;pins:Record<'verify'|'history',ReleaseCiPin>;signal:AbortSignal;read?:ReleaseCiReader}){
 const {workspace,source,signal}=options,pins=structuredClone(options.pins);
 if(!isAbsolute(workspace)||!/^[a-f0-9]{40}$/.test(source)||!pins||Object.keys(pins).sort().join(',')!=='history,verify')throw Error('RELEASE_CI_INPUT_INVALID');
 for(const pin of Object.values(pins))if(!pin||!Number.isSafeInteger(pin.runId)||pin.runId<1||!Number.isSafeInteger(pin.attempt)||pin.attempt<1||!/^[a-f0-9]{64}$/.test(pin.workflowSha256))throw Error('RELEASE_CI_PIN_INVALID');
 if(pins.verify.runId===pins.history.runId)throw Error('RELEASE_CI_PIN_INVALID');
 const read=options.read??githubReleaseCiReader(workspace),results=[];
 for(const key of ['verify','history'] as const){
  const pin=pins[key],workflow=workflows[key],bytes=await command('git',['show',source+':'+workflow.path],workspace,signal);
  if(createHash('sha256').update(bytes).digest('hex')!==pin.workflowSha256)throw Error('RELEASE_CI_WORKFLOW_CHANGED');
  const path=`repos/${repository}/actions/runs/${pin.runId}`;
  const checkRun=(input:unknown)=>{
   const run=object(input);
   if(run.id!==pin.runId||run.head_sha!==source||run.path!==workflow.path||run.event!=='push'||run.run_attempt!==pin.attempt||object(run.repository).full_name!==repository||object(run.head_repository).full_name!==repository)throw Error('RELEASE_CI_RUN_IDENTITY_CHANGED');
   if(run.status!=='completed'||run.conclusion!=='success')throw Error('RELEASE_CI_NOT_SUCCESSFUL');
  };
  checkRun(await read(path,signal));
  const response=object(await read(path+`/attempts/${pin.attempt}/jobs?per_page=100`,signal));
  if(response.total_count!==1||!Array.isArray(response.jobs)||response.jobs.length!==1)throw Error('RELEASE_CI_JOB_SET_CHANGED');
  const job=object(response.jobs[0]);
  if(job.name!==workflow.job||job.head_sha!==source||job.run_id!==pin.runId||job.run_attempt!==pin.attempt||!Number.isSafeInteger(job.id)||Number(job.id)<1)throw Error('RELEASE_CI_JOB_IDENTITY_CHANGED');
  if(job.status!=='completed'||job.conclusion!=='success')throw Error('RELEASE_CI_NOT_SUCCESSFUL');
  checkRun(await read(path,signal));
  results.push({workflow:workflow.path,workflowSha256:pin.workflowSha256,runId:pin.runId,attempt:pin.attempt,jobId:job.id as number,url:`https://github.com/${repository}/actions/runs/${pin.runId}`});
 }
 signal.throwIfAborted();return{source,repository,runs:results};
}
