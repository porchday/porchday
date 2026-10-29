import{constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,lstatSync,existsSync}from'node:fs';
import{join,isAbsolute}from'node:path';
import{setTimeout as sleep}from'node:timers/promises';
import{deploymentPlanHash,recoveryTarget}from'./deployment-recovery.ts';
import{readMonitorReview,readMonitorRecovery}from'./release-activation-review.ts';
import{verifyMonitorRead}from'./release-monitor-verification.ts';
import{retainReleaseEvidence}from'./release-verification.ts';
/** One persisted window for a natural cron observation. Only public GETs repeat;
 * no tick, deployment or authenticated journey is invoked here. */
export async function waitForMonitorRecovery(options:Omit<Parameters<typeof verifyMonitorRead>[0],'phase'|'retainAttempt'>,signal:AbortSignal):Promise<boolean>{
 const {plan,review,directory}=options,baseline=readMonitorReview(plan,review),hash=deploymentPlanHash(plan);
 if(!recoveryTarget(plan.worker).monitor||!baseline||!readMonitorRecovery(plan,review,baseline.at)||options.version!==plan.candidateVersion)throw Error('MONITOR_RECOVERY_WAIT_SCOPE_INVALID');
 options.assertScope();signal.throwIfAborted();
 const dir=lstatSync(directory);if(!isAbsolute(directory)||!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o077)!==0)throw Error('MONITOR_RECOVERY_WAIT_PERMISSIONS');
 const path=join(directory,'monitor-observation-window-'+hash+'.json');
 if(!existsSync(path)){
  const startedAt=Date.now(),record={v:1,planHash:hash,version:plan.candidateVersion,startedAt,deadline:startedAt+75000};
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 }
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>4096)throw Error('MONITOR_RECOVERY_WAIT_PERMISSIONS');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let window;try{window=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 if(!window||Object.keys(window).sort().join(',')!=='deadline,planHash,startedAt,v,version'||window.v!==1||window.planHash!==hash||window.version!==plan.candidateVersion||!Number.isSafeInteger(window.startedAt)||window.startedAt<0||window.startedAt>Date.now()||window.deadline!==window.startedAt+75000)throw Error('MONITOR_RECOVERY_WAIT_INVALID');
 const readyPath=join(directory,'monitor-observation-ready-'+hash+'.json');
 if(existsSync(readyPath)){
  const stat=lstatSync(readyPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>4096)throw Error('MONITOR_RECOVERY_WAIT_PERMISSIONS');
  const fd=openSync(readyPath,constants.O_RDONLY|constants.O_NOFOLLOW);let receipt;try{receipt=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
  if(!receipt||Object.keys(receipt).sort().join(',')!=='deadline,planHash,readyAt,startedAt,v,version'||receipt.v!==1||receipt.planHash!==hash||receipt.version!==plan.candidateVersion||receipt.startedAt!==window.startedAt||receipt.deadline!==window.deadline||!Number.isSafeInteger(receipt.readyAt)||receipt.readyAt<window.startedAt||receipt.readyAt>=window.deadline||receipt.readyAt>Date.now())throw Error('MONITOR_RECOVERY_WAIT_INVALID');
  // A previously successful window is not repeated. Recheck current health once;
  // a fresh failure remains unresolved rather than replaying the journey here.
  await verifyMonitorRead({...options,retainAttempt:true},signal);return true;
 }
 const finish=(ready:boolean)=>{options.assertScope();signal.throwIfAborted();retainReleaseEvidence(directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash:hash,version:plan.candidateVersion,kind:'monitor-observation-window',detail:{startedAt:window.startedAt,deadline:window.deadline,ready}});return ready;};
 while(Date.now()<window.deadline){
  options.assertScope();signal.throwIfAborted();const remaining=window.deadline-Date.now();if(remaining<=0)break;
  const attempt=AbortSignal.any([signal,AbortSignal.timeout(remaining)]);
  try{await verifyMonitorRead({...options,retainAttempt:true},attempt);if(Date.now()>=window.deadline)break;options.assertScope();signal.throwIfAborted();const fd=openSync(readyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify({...window,readyAt:Date.now()})+'\n');fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}return finish(true);}
  catch(error){signal.throwIfAborted();if(Date.now()>=window.deadline)break;const code=error instanceof Error?error.message:'';if(!['MONITOR_RECOVERY_NOT_READY','MONITOR_RELEASE_READ_DEADLINE'].includes(code))throw error;}
  await sleep(Math.min(2000,Math.max(0,window.deadline-Date.now())),undefined,{signal});
 }
 return finish(false);
}
