import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {deploymentPlanHash,type DeploymentPlan} from './deployment-recovery.ts';
import type {ContinuityCommandEvent} from './release-continuity-command.ts';

/** Permanent failure evidence for this operation. Healthy later samples cannot
 * clear it; resumed recovery reads the same gate even without a live observer.
 * Contains no request bodies, member identifiers, cookies or provider errors. */
export function createContinuityGate(directory:string,plan:DeploymentPlan){
 const planHash=deploymentPlanHash(plan),operationId=plan.operationId;
 const path=join(directory,'continuity-failure-'+operationId+'.json');
 const scope=()=>{const s=lstatSync(directory);if(!isAbsolute(directory)||realpathSync(directory)!==directory||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('CONTINUITY_GATE_DIRECTORY_INVALID');};
 const failed=()=>{
  scope();let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
  try{
   const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size<1||s.size>4096)throw Error('CONTINUITY_GATE_RECORD_INVALID');
   const value=JSON.parse(readFileSync(fd,'utf8'));
   if(Object.keys(value).sort().join(',')!=='at,operationId,planHash,v'||value.v!==1||value.operationId!==operationId||value.planHash!==planHash||typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||new Date(value.at).toISOString()!==value.at)throw Error('CONTINUITY_GATE_RECORD_INVALID');
   return true;
  }finally{closeSync(fd);}
 };
 const assertPromotion=()=>{if(failed())throw Error('DEPLOYMENT_CONTINUITY_FAILED');};
 const retain=(event:ContinuityCommandEvent)=>{
  if(event.kind!=='sample'||event.sample.healthy)return;
  if(!Number.isFinite(Date.parse(event.sample.at))||new Date(event.sample.at).toISOString()!==event.sample.at)throw Error('CONTINUITY_GATE_SAMPLE_INVALID');
  if(failed())return;
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify({v:1,operationId,planHash,at:event.sample.at})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 };
 return {failed,assertPromotion,retain};
}
