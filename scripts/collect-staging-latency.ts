import {open} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {readPrivate,writePrivate,privatePath} from './hosted-smoke-support';
import {collect,validatePlan,type Plan} from './staging-latency-collector';

// Manifest and output must live under artifacts/private/hosted-smoke, mode 0600.
// Outputs contain only numeric observations; the manifest contains the session.
async function main(){
 const [flag,manifest,output,...extra]=process.argv.slice(2);
 if(flag!=='--run'||!manifest||!output||extra.length)throw Error('INPUT');
 const plan=await readPrivate<Plan>(manifest);validatePlan(plan,Date.now());
 privatePath(output);
 // Reserve immutable destinations before any traffic. Refuse to overwrite a prior run.
 await writePrivate(output,{state:'collecting',expectedAttempts:plan.attempts},true);
 const journal=await open(privatePath(output+'.attempts.jsonl'),'wx',0o600);
 try{
  const result=await collect(plan,{fetch,now:Date.now,monotonic:()=>performance.now(),sleep:setTimeout,record:async sample=>{await journal.write(JSON.stringify(sample)+'\n');await journal.sync();}});
  await writePrivate(output,result);
  console.log(JSON.stringify({reason:result.reason,attempts:result.samples.length,expectedAttempts:result.expectedAttempts,successes:result.samples.filter(s=>s.outcome==='success').length,acceptanceClaim:false}));
  if(result.reason!=='complete')process.exitCode=2;
 }finally{await journal.close();}
}
main().catch(()=>{console.error('STAGING_LATENCY_COLLECTION_FAILED');process.exitCode=1;});
