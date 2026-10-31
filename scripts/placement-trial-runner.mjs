import {constants,openSync,closeSync,fstatSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
function sleep(ms,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});
 });
}
import {FilePlacementTrialJournal} from './placement-trial-journal.mjs';

/** The activation controller retains the deployment lease throughout this
 * finite experiment. No daemon, provider write, login or implicit retry occurs.
 * Collectors receive a bounded signal and return sanitized observations only.
 */
export async function runPlacementTrial({directory,operationId,baseline,assertLease,assertInventory,collect,signal}) {
  assertLease();signal.throwIfAborted();
  let startedAt=Date.now();
  const first=join(directory,'00001.json');
  if(existsSync(first)) {
    const fd=openSync(first,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const s=fstatSync(fd);
      if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0||s.size>4096)throw Error('TRIAL_JOURNAL_PERMISSIONS');
      startedAt=JSON.parse(readFileSync(fd,'utf8')).startedAt;
    }finally{closeSync(fd);}
  }
  const journal=new FilePlacementTrialJournal({directory,operationId,startedAt,baseline,assertLease});
  let state=journal.read()??journal.start();
  while(state.status==='watching') {
    signal.throwIfAborted();assertLease();
    const due=startedAt+(Math.floor((state.at-startedAt)/60000)+1)*60000;
    await sleep(Math.max(0,due-Date.now()),signal);
    const at=Date.now();
    // Do not make additional external reads after an interruption has already
    // invalidated the observation coverage. Persist a stop before returning.
    let sample;
    if(at-state.at>=120000)sample={at,auth:false,revocation:false,privacy:false,readiness:false,publicAssets:false,refused:false,connection:null,window:null};
    else {
      await assertInventory(signal);assertLease();
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      let timer;
      try {
        sample=await Promise.race([
          collect({signal:combined,at,startedAt,lastWindowAt:state.lastWindowAt}),
          new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('TRIAL_COLLECTOR_TIMEOUT'));},45000);}),
        ]);
        // The collector cannot choose the watch clock or replay old minutes.
        sample={...sample,at:Date.now()};
      }catch{
        signal.throwIfAborted();
        sample={at,auth:false,revocation:false,privacy:false,readiness:false,publicAssets:false,refused:false,connection:null,window:null};
      }finally{clearTimeout(timer);controller.abort();}
    }
    signal.throwIfAborted();assertLease();
    state=journal.sample(state,sample);
  }
  await assertInventory(signal);assertLease();
  return state.status==='retain'?'healthy':'unhealthy';
}
