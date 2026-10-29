import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {deploymentPlanHash,recoveryTarget,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';

type Health=Awaited<ReturnType<DeploymentPorts['verify']>>;
export type BrowserAcceptance=(signal:AbortSignal)=>Promise<Health>;
/** Required evidence survives loss of the browser process. A claimed observation
 * is never repeated; unknown evidence cannot become candidate acceptance. */
export function createBrowserGate(directory:string,plan:DeploymentPlan){
 const planHash=deploymentPlanHash(plan),operationId=plan.operationId;
 const scope=()=>{const s=lstatSync(directory);if(!recoveryTarget(plan.worker).frontend||!isAbsolute(directory)||realpathSync(directory)!==directory||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('BROWSER_GATE_SCOPE_INVALID');};
 const path=(kind:string)=>join(directory,`browser-gate-${operationId}-${kind}.json`);
 const read=(kind:string)=>{
  scope();let fd:number;try{fd=openSync(path(kind),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size<1||s.size>4096)throw Error('BROWSER_GATE_RECORD_INVALID');
   const r=JSON.parse(readFileSync(fd,'utf8'));if(Object.keys(r).sort().join(',')!=='at,operationId,planHash,status,v'||r.v!==1||r.operationId!==operationId||r.planHash!==planHash||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at))||new Date(r.at).toISOString()!==r.at||!(kind==='result'?['healthy','unhealthy','unknown']:[kind]).includes(r.status))throw Error('BROWSER_GATE_RECORD_INVALID');return r;
  }finally{closeSync(fd);}
 };
 const write=(kind:string,status:string)=>{scope();const fd=openSync(path(kind),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify({v:1,operationId,planHash,at:new Date().toISOString(),status})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 };
 return{require:()=>write('required','required'),async verify(signal:AbortSignal,accept?:BrowserAcceptance):Promise<Health>{
  signal.throwIfAborted();if(!read('required'))return accept?'unknown':'healthy';
  const claimed=read('claimed'),result=read('result');if(result){if(!claimed)throw Error('BROWSER_GATE_UNCLAIMED_RESULT');return result.status as Health;}
  if(claimed||!accept)return 'unknown';write('claimed','claimed');
  let status:Health='unknown';try{const observed=await accept(signal);signal.throwIfAborted();if(observed==='healthy'||observed==='unhealthy')status=observed;}catch{/* Preserve uncertainty without provider/browser exception text. */}
  write('result',status);return status;
 }};
}

/** Browser evidence can only downgrade existing verification. Rollback baseline
 * verification stays independent of the failed candidate browser. */
export function withBrowserAcceptance(plan:DeploymentPlan,directory:string,verify:DeploymentPorts['verify'],accept?:BrowserAcceptance):DeploymentPorts['verify']{
 return async(version,signal)=>{const health=await verify(version,signal);if(health!=='healthy'||version!==plan.candidateVersion||!recoveryTarget(plan.worker).frontend)return health;return createBrowserGate(directory,plan).verify(signal,accept);};
}
