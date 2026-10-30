import {constants,openSync,closeSync,writeFileSync,fsyncSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {deploymentPlanHash,rollbackOperationId,type DeploymentPlan,type DeploymentPorts,type DeploymentObservation} from './deployment-recovery.ts';

type Options={plan:DeploymentPlan;ports:DeploymentPorts;proofDirectory:string;assertScope:()=>void;
 /** Start one owned request and independently confirm it is still executing.
  * Do not wait for its completion or return success for a dispatched request. */
 start:(signal:AbortSignal)=>Promise<'in-flight'>;
 /** Release any owned barrier and verify the original request, without replay. */
 finish:(signal:AbortSignal)=>Promise<'verified'>};
const failure=()=>new Error('STAGING_INFLIGHT_PROBE_UNVERIFIED');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A staging-only decorator for reviewed controller ports. It does not create
 * a deployment intent, authorize a version, dispatch independently, or relax
 * controller deadlines. The harness must release owned barriers in its finally
 * path even if rollback is not observed. A historical probe requires separate
 * read-only reconciliation, never another invocation of these callbacks. */
export function withStagingInflightProbe(input:Options,caller:AbortSignal):DeploymentPorts{
 const plan=structuredClone(input.plan),planHash=deploymentPlanHash(plan),rollbackId=rollbackOperationId(plan.operationId);
 if(plan.worker!=='porchday-staging'||plan.assetManifests)throw failure();
 const directory=input.proofDirectory,stat=lstatSync(directory);
 if(!isAbsolute(directory)||realpathSync(directory)!==directory||!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw failure();
 const path=(kind:string)=>join(directory,`inflight-${plan.operationId}-${kind}.json`);
 if(existsSync(path('intent')))throw failure();
 const save=(kind:string,value:unknown)=>{
  const fd=openSync(path(kind),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify({v:1,at:new Date().toISOString(),operationId:plan.operationId,planHash,value})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 };
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();caller.throwIfAborted();input.assertScope();};
 let phase:'idle'|'starting'|'armed'|'finishing'|'verified'|'failed'='idle',candidate:DeploymentObservation|undefined,restoredId:string|undefined;
 return{
  authorize:(...args)=>input.ports.authorize(...args),
  deploy:async(version,operationId,signal)=>{
   const combined=AbortSignal.any([signal,caller]);check(combined);
   if(version!==plan.baselineVersion||operationId!==rollbackId){
    if(phase!=='idle'||version!==plan.candidateVersion||operationId!==plan.operationId)throw failure();
    return input.ports.deploy(version,operationId,combined);
   }
   if(phase!=='idle'||!candidate)throw failure();phase='starting';
   try{
    save('intent',{candidateDeploymentId:candidate.deploymentId,automaticRetry:false});
    const status=await input.start(combined);check(combined);if(status!=='in-flight')throw failure();
    save('armed',{status:'in-flight'});phase='armed';
   }catch{phase='failed';throw failure();}
   // Preserve armed state after a lost deployment reply. Only an exact provider
   // observation can permit finish; the controller never repeats this POST.
   return input.ports.deploy(version,operationId,combined);
  },
  observe:async signal=>{
   const combined=AbortSignal.any([signal,caller]);check(combined);if(phase==='failed'||phase==='starting'||phase==='finishing')throw failure();
   const observed=await input.ports.observe(combined);check(combined);
   if(!observed||!uuid.test(observed.version)||!uuid.test(observed.deploymentId)||observed.operationId!==null&&!uuid.test(observed.operationId))throw failure();
   if(phase==='idle'&&observed.version===plan.candidateVersion&&observed.operationId===plan.operationId)candidate={...observed};
   if(phase==='armed'&&observed.version===plan.baselineVersion&&observed.operationId===rollbackId){
    phase='finishing';try{
     save('restored',{deploymentId:observed.deploymentId});
     const status=await input.finish(combined);check(combined);if(status!=='verified')throw failure();
     save('result',{status:'verified',deploymentId:observed.deploymentId});restoredId=observed.deploymentId;phase='verified';
    }catch{phase='failed';throw failure();}
   }
   if(phase==='verified'&&(observed.version!==plan.baselineVersion||observed.operationId!==rollbackId||observed.deploymentId!==restoredId))throw failure();
   return observed;
  },
  verify:async(version,signal)=>{
   check(signal);if(version===plan.baselineVersion&&phase!=='idle'&&phase!=='verified')return 'unknown';
   return input.ports.verify(version,AbortSignal.any([signal,caller]));
  },
 };
}
