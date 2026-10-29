import {parseMonitorSnapshot,assertMonitorContinuity,assertMonitorRecoveryContinuity,assertMonitorUnavailable,type MonitorSnapshot} from './release-monitor-state.ts';
import {deploymentPlanHash,recoveryTarget,type DeploymentPlan} from './deployment-recovery.ts';
import {readMonitorReview,readMonitorRecovery,type ActivationReviewEvidence} from './release-activation-review.ts';
import {retainReleaseEvidence} from './release-verification.ts';
/** Public GET only, with a fixed origin and bounded body. No synthetic login,
 * cron invocation, storage write or provider mutation is performed here. */
export async function verifyMonitorRead(options:{plan:DeploymentPlan;review:ActivationReviewEvidence;version:string;phase?:'before-activation'|'verification';directory:string;assertScope:()=>void;fetch?:typeof fetch},signal:AbortSignal):Promise<MonitorSnapshot|null>{
 const {plan,review,version}=options,target=recoveryTarget(plan.worker),baseline=readMonitorReview(plan,review);
 if(!target.monitor||!baseline||![plan.baselineVersion,plan.candidateVersion].includes(version))throw Error('MONITOR_RELEASE_SCOPE_CHANGED');
 const recovery=readMonitorRecovery(plan,review,baseline.at);
 if(options.phase==='before-activation'&&version!==plan.baselineVersion)throw Error('MONITOR_RELEASE_SCOPE_CHANGED');
 const freshness=()=>{if(recovery&&(Date.now()<baseline.at||Date.now()-baseline.at>6*60*60000||Date.now()<recovery.failureAt||Date.now()-recovery.failureAt>30*60000||baseline.history.expected+Math.floor(Date.now()/60000)-Math.floor(baseline.at/60000)>43200))throw Error('MONITOR_RECOVERY_EVIDENCE_EXPIRED');};
 freshness();options.assertScope();signal.throwIfAborted();
 const origin=target.environment==='staging'?'https://staging-status.porchday.com':'https://status.porchday.com';
 const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const work=(async()=>{
   const response=await(options.fetch??fetch)(origin+'/status',{redirect:'error',cache:'no-store',signal:combined});
   const reader=response.body?.getReader();if(!reader)throw Error('MONITOR_RELEASE_EMPTY_RESPONSE');
   const cancel=()=>{void reader.cancel().catch(()=>{});};combined.addEventListener('abort',cancel,{once:true});const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>16384)throw Error('MONITOR_RELEASE_RESPONSE_TOO_LARGE');chunks.push(r.value);}}
   finally{combined.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
   combined.throwIfAborted();const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const body=JSON.parse(new TextDecoder().decode(bytes));freshness();
   if(recovery&&options.phase==='before-activation'&&response.status!==200){
    assertMonitorUnavailable(response.status,body);options.assertScope();combined.throwIfAborted();
    retainReleaseEvidence(options.directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash:deploymentPlanHash(plan),version,kind:'monitor-unavailable-baseline',detail:{historicalBaseline:baseline,status:response.status,body,recovery}});
    return null;
   }
   const current=parseMonitorSnapshot(target.environment,response.status,body,Date.now());
   const continuity=recovery?assertMonitorRecoveryContinuity(baseline,current):assertMonitorContinuity(baseline,current);options.assertScope();combined.throwIfAborted();
   retainReleaseEvidence(options.directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash:deploymentPlanHash(plan),version,kind:'monitor-history',detail:{current,continuity}});
   return current;
  })();
  return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('MONITOR_RELEASE_READ_DEADLINE'));},5000);})]);
 }finally{if(timer)clearTimeout(timer);controller.abort();}
}
