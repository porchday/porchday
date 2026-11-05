import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
export const parityCapabilities = ['navigation','feed','albums','photo-sharing','photo-dates','audiences','invitations','history','portability','notifications'] as const;
type Matrix = {version:1; capabilities:Array<{id:string;ios:'verified'|'pending';macos:'verified'|'pending';evidence:string[]}>};
export function validateNativeParity(input:unknown):Matrix {
 const m=input as Matrix;
 if(!m||m.version!==1||!Array.isArray(m.capabilities)||m.capabilities.length!==parityCapabilities.length||new Set(m.capabilities.map(x=>x.id)).size!==parityCapabilities.length)throw Error('NATIVE_PARITY_MATRIX_INVALID');
 for(const id of parityCapabilities){const row=m.capabilities.find(x=>x.id===id);if(!row||!Array.isArray(row.evidence)||!row.evidence.length||row.evidence.some(x=>typeof x!=='string'||!x.trim()))throw Error('NATIVE_PARITY_EVIDENCE_MISSING:'+id);if(row.ios!=='verified'||row.macos!=='verified')throw Error('NATIVE_PARITY_PENDING:'+id);}
 return m;
}
function command(binary:string,args:string[],workspace:string,signal:AbortSignal):Promise<string>{return new Promise((resolve,reject)=>execFile(binary,args,{cwd:workspace,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,signal},(error,out)=>error?reject(Error('NATIVE_PARITY_READ_FAILED')):resolve(out)));}
export function validateNativeRun(run:any,source:string,path:string){
 if(!run||run.head_sha!==source||run.path!==path||run.event!=='push'||run.repository?.full_name!=='porchday/porchday'||run.head_repository?.full_name!=='porchday/porchday'||run.status!=='completed'||run.conclusion!=='success'||!Number.isSafeInteger(run.id)||run.id<1||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)throw Error('NATIVE_PARITY_CI_NOT_VERIFIED');
}
export function validateNativeJobs(jobs:any,run:any,source:string,file:string,jobName:string){
 const job=jobs?.jobs?.[0];
 if(jobs?.total_count!==1||jobs.jobs?.length!==1||job.name!==jobName||job.head_sha!==source||job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.status!=='completed'||job.conclusion!=='success')throw Error('NATIVE_PARITY_CI_JOB_NOT_VERIFIED');
 const required=file==='ios.yml'
  ? ['Verify JavaScript/native cryptographic interoperability','Build and run native tests in simulator','Launch app and capture simulator evidence']
  : ['Compile shared native Mac app','Run shared calendar, tag and media contract tests','Package verification artifact'];
 for(const name of required){const steps=job.steps?.filter((s:any)=>s.name===name);if(steps?.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')throw Error('NATIVE_PARITY_CI_STEP_NOT_VERIFIED');}
}
/** Read-only, exact candidate-source gate. A green compiler does not replace the
 * reviewed capability matrix. Old recovery intents bypass only this new gate so
 * an outage rollback cannot be prevented by missing feature work. */
export async function verifyProductionNativeParity(workspace:string,source:string,signal:AbortSignal){
 if(!isAbsolute(workspace)||! /^[a-f0-9]{40}$/.test(source))throw Error('NATIVE_PARITY_INPUT_INVALID');
 validateNativeParity(JSON.parse(await command('git',['show',source+':docs/native-parity.json'],workspace,signal)));
 const receipts=[];
 for(const [file,jobName] of [['ios.yml','native'],['macos.yml','build']]){
  const path='.github/workflows/'+file;
  const response=JSON.parse(await command('gh',['api','--hostname','github.com','--method','GET',`repos/porchday/porchday/actions/workflows/${file}/runs?head_sha=${source}&event=push&per_page=100`],workspace,signal));
  const run=response.workflow_runs?.find((r:any)=>r.head_sha===source&&r.path===path&&r.event==='push');validateNativeRun(run,source,path);
  const jobs=JSON.parse(await command('gh',['api','--hostname','github.com','--method','GET',`repos/porchday/porchday/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`],workspace,signal));
  validateNativeJobs(jobs,run,source,file,jobName);
  const fresh=JSON.parse(await command('gh',['api','--hostname','github.com','--method','GET',`repos/porchday/porchday/actions/runs/${run.id}`],workspace,signal));validateNativeRun(fresh,source,path);if(fresh.run_attempt!==run.run_attempt)throw Error('NATIVE_PARITY_CI_CHANGED');
  receipts.push({source,workflow:path,run:run.id,attempt:run.run_attempt});
 }
 return {source,receipts};
}
