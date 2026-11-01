import{constants,openSync,closeSync,fsyncSync,fstatSync,lstatSync,realpathSync,writeFileSync,readFileSync}from'node:fs';
import{join,isAbsolute}from'node:path';
import{deploymentPlanHash,rollbackOperationId,type DeploymentPlan}from'./deployment-recovery.ts';
export type DeploymentWriteEvent={kind:'intent'|'response'|'transport-error';operationId:string;version:string;at:string;status?:number;ray?:string;bodyState?:'json'|'invalid';success?:boolean;errors?:{code?:number;message?:string}[]};
/** Exclusive receipts are a second barrier against a duplicate provider POST.
 * No credentials, session data or full provider payload is persisted. */
export function deploymentWriteRecorder(directory:string,plan:DeploymentPlan,assertScope:()=>void){
 const hash=deploymentPlanHash(plan);
 return(event:DeploymentWriteEvent)=>{
  assertScope();const stat=lstatSync(directory);if(!isAbsolute(directory)||realpathSync(directory)!==directory||!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('DEPLOYMENT_RECEIPT_DIRECTORY_INVALID');
  const candidate=event.operationId===plan.operationId&&event.version===plan.candidateVersion,rollback=event.operationId===rollbackOperationId(plan.operationId)&&event.version===plan.baselineVersion;
  if(!candidate&&!rollback)throw Error('DEPLOYMENT_RECEIPT_SCOPE_INVALID');
  const suffix=event.kind==='intent'?'intent':'result';
  if(suffix==='intent'){
   try{lstatSync(join(directory,'provider-write-'+event.operationId+'-result.json'));throw Error('DEPLOYMENT_RECEIPT_ALREADY_EXISTS');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(suffix==='result'){
   const fd=openSync(join(directory,'provider-write-'+event.operationId+'-intent.json'),constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.size>16384||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('DEPLOYMENT_RECEIPT_INVALID');const intent=JSON.parse(readFileSync(fd,'utf8'));if(intent.planHash!==hash||intent.kind!=='intent'||intent.operationId!==event.operationId||intent.version!==event.version)throw Error('DEPLOYMENT_RECEIPT_SCOPE_INVALID');}finally{closeSync(fd);}
  }
  const bytes=JSON.stringify({v:1,planHash:hash,worker:plan.worker,...event})+'\n';if(Buffer.byteLength(bytes)>16384)throw Error('DEPLOYMENT_RECEIPT_TOO_LARGE');
  const fd=openSync(join(directory,'provider-write-'+event.operationId+'-'+suffix+'.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 };
}
