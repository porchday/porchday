import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyReleaseCi,githubReleaseCiReader,type ReleaseCiReader} from './release-ci.ts';
let workspace:string,source:string;
const bytes='reviewed workflow fixture\n',workflowSha256=createHash('sha256').update(bytes).digest('hex');
const pins={verify:{runId:10,attempt:1,workflowSha256},history:{runId:20,attempt:2,workflowSha256}};
beforeEach(()=>{
 workspace=mkdtempSync(join(tmpdir(),'porchday-ci-'));mkdirSync(join(workspace,'.github/workflows'),{recursive:true});
 for(const name of ['ci.yml','secret-scan.yml'])writeFileSync(join(workspace,'.github/workflows',name),bytes);
 const run=(args:string[])=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 run(['init','-q']);run(['config','user.name','Synthetic Test']);run(['config','user.email','synthetic@example.invalid']);run(['add','.']);run(['commit','-qm','fixture']);source=run(['rev-parse','HEAD']);
});
afterEach(()=>rmSync(workspace,{recursive:true,force:true}));
function fixture(){
 const calls:string[]=[];
 const read:ReleaseCiReader=async path=>{
  calls.push(path);const verify=path.includes('/10'),pin=verify?pins.verify:pins.history;
  if(path.includes('/jobs?'))return{total_count:1,jobs:[{id:pin.runId+100,name:verify?'verify':'history',head_sha:source,run_id:pin.runId,run_attempt:pin.attempt,status:'completed',conclusion:'success'}]};
  return{id:pin.runId,head_sha:source,path:'.github/workflows/'+(verify?'ci.yml':'secret-scan.yml'),event:'push',run_attempt:pin.attempt,status:'completed',conclusion:'success',repository:{full_name:'porchday/porchday'},head_repository:{full_name:'porchday/porchday'}};
 };
 return{calls,read};
}
describe('exact-source release CI authorization',()=>{
 it('checks pinned workflows from Git plus current run attempts and jobs',async()=>{
  const f=fixture();writeFileSync(join(workspace,'.github/workflows/ci.yml'),'uncommitted change');
  const proof=await verifyReleaseCi({workspace,source,pins,read:f.read,signal:AbortSignal.timeout(5000)});
  expect(proof.runs.map(run=>run.jobId)).toEqual([110,120]);expect(f.calls).toHaveLength(6);expect(proof.source).toBe(source);
 });
 it('rejects unreviewed workflow changes before reading remote status',async()=>{
  const f=fixture();await expect(verifyReleaseCi({workspace,source,pins:{...pins,verify:{...pins.verify,workflowSha256:'0'.repeat(64)}},read:f.read,signal:AbortSignal.timeout(5000)})).rejects.toThrow('WORKFLOW_CHANGED');expect(f.calls).toEqual([]);
 });
 it('rejects wrong commit, PR event, fork, workflow path, attempt and unsuccessful runs',async()=>{
  for(const patch of [{head_sha:'f'.repeat(40)},{event:'pull_request'},{head_repository:{full_name:'other/fork'}},{path:'.github/workflows/other.yml'},{run_attempt:2},{status:'in_progress'},{conclusion:'failure'}]){
   const f=fixture();await expect(verifyReleaseCi({workspace,source,pins,signal:AbortSignal.timeout(5000),read:async(path,signal)=>({...await f.read(path,signal) as object,...patch})})).rejects.toThrow(/RUN_IDENTITY_CHANGED|NOT_SUCCESSFUL/);
  }
 });
 it('rejects missing jobs, wrong job identities and skipped jobs',async()=>{
  for(const patch of [{name:'other'},{head_sha:'f'.repeat(40)},{run_attempt:9},{conclusion:'skipped'}]){
   const f=fixture();const read:ReleaseCiReader=async(path,signal)=>{const result=await f.read(path,signal) as {jobs?:object[]};return result.jobs?{...result,jobs:[{...result.jobs[0],...patch}]}:result;};
   await expect(verifyReleaseCi({workspace,source,pins,read,signal:AbortSignal.timeout(5000)})).rejects.toThrow(/JOB_IDENTITY_CHANGED|NOT_SUCCESSFUL/);
  }
  const f=fixture();await expect(verifyReleaseCi({workspace,source,pins,signal:AbortSignal.timeout(5000),read:async(path,signal)=>path.includes('/jobs?')?{total_count:2,jobs:[]} :f.read(path,signal)})).rejects.toThrow('JOB_SET_CHANGED');
 });
 it('detects a new run attempt during verification',async()=>{
  const f=fixture();let reads=0;
  await expect(verifyReleaseCi({workspace,source,pins,signal:AbortSignal.timeout(5000),read:async(path,signal)=>{const result=await f.read(path,signal);return ++reads===3?{...result as object,run_attempt:2}:result;}})).rejects.toThrow('RUN_IDENTITY_CHANGED');
 });
 it('rejects mutable source refs, cancellation and non-read API paths',async()=>{
  const f=fixture();await expect(verifyReleaseCi({workspace,source:'main',pins,read:f.read,signal:AbortSignal.timeout(5000)})).rejects.toThrow('INPUT_INVALID');
  await expect(verifyReleaseCi({workspace,source,pins,read:f.read,signal:AbortSignal.abort()})).rejects.toThrow();expect(f.calls).toEqual([]);
  await expect(githubReleaseCiReader(workspace)('repos/porchday/porchday/actions/runs/10/rerun',AbortSignal.timeout(5000))).rejects.toThrow('PATH_INVALID');
 });
});
