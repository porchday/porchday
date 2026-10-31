import {openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import type {AuthCommitRequestWindow} from './auth-commit-cohort-proof';

const fixtureSchema=z.object({memberId:z.uuid(),sessionId:z.uuid(),cookie:z.string().min(1).max(16384).regex(/^[^\r\n]+$/)}).strict();
type Options={directory:string;fixtures:z.infer<typeof fixtureSchema>[];baselineSequence:string;generation:string;assertScope:()=>void;transport?:typeof fetch};
const failure=()=>new Error('AUTH_COHORT_DISPATCH_UNVERIFIED');

/** One-shot staging requests only. The caller owns fixture authorization,
 * provider/lease admission and post-rollback canonical proof. Never resume a
 * directory containing the batch intent, even when no result was retained. */
export async function dispatchAuthCommitCohort(input:Options,caller:AbortSignal):Promise<AuthCommitRequestWindow[]>{
 const check=()=>{caller.throwIfAborted();input.assertScope();};
 const save=(name:string,value:unknown)=>{
  const fd=openSync(join(input.directory,name+'.json'),'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(input.directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
 };
 try{
  check();const fixtures=z.array(fixtureSchema).min(2).max(4).parse(input.fixtures);
  if(new Set(fixtures.map(f=>f.memberId)).size!==fixtures.length||new Set(fixtures.map(f=>f.sessionId)).size!==fixtures.length||new Set(fixtures.map(f=>f.cookie)).size!==fixtures.length)throw failure();
  const baselineSequence=z.string().regex(/^(0|[1-9][0-9]*)$/).parse(input.baselineSequence),generation=z.uuid().parse(input.generation);
  // All intents are durable before ANY request. A partial intent write failure
  // leaves this directory unusable and dispatches nothing.
  save('cohort-intent',{at:new Date().toISOString(),baselineSequence,generation,count:fixtures.length,automaticRetry:false});
  fixtures.forEach(({memberId,sessionId},index)=>save(`cohort-${index}-intent`,{memberId,sessionId,automaticRetry:false}));
  check();
  const transport=input.transport??fetch;
  async function request(cookie:string,path:string,method:'POST'|'GET'){
   check();const signal=AbortSignal.any([caller,AbortSignal.timeout(10000)]);let abort:()=>void=()=>{};
   try{
    // Bound even an injected transport that ignores cancellation. No retries;
    // a timed-out POST is unknown and can still have committed remotely.
    return await Promise.race([(async()=>{
     const response=await transport('https://staging.porchday.com'+path,{method,redirect:'error',signal,headers:{Cookie:cookie,Origin:'https://staging.porchday.com','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
     // Response payload is not evidence and may contain private data.
     await response.body?.cancel();return response.status;
    })(),new Promise<never>((_,reject)=>{abort=()=>reject(failure());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);
   }finally{signal.removeEventListener('abort',abort);}
  }
  const outcomes=await Promise.allSettled(fixtures.map(async(fixture,index)=>{
   const startedAt=Date.now();let status:number;
   try{status=await request(fixture.cookie,'/api/auth/revoke-sessions','POST');}
   catch{save(`cohort-${index}-unknown`,{at:new Date().toISOString(),code:'HTTP_OUTCOME_UNKNOWN',automaticRetry:false});throw failure();}
   const endedAt=Date.now();save(`cohort-${index}-result`,{startedAt,endedAt,status});
   check();if(status!==200||endedAt-startedAt>10000)throw failure();
   let deniedStatus:number;
   try{deniedStatus=await request(fixture.cookie,'/api/v1/me?bootstrap=1','GET');}
   catch{save(`cohort-${index}-denial-unknown`,{at:new Date().toISOString(),code:'DENIAL_OUTCOME_UNKNOWN',automaticRetry:false});throw failure();}
   save(`cohort-${index}-denial`,{at:new Date().toISOString(),status:deniedStatus});check();if(deniedStatus!==401)throw failure();
   return{memberId:fixture.memberId,sessionId:fixture.sessionId,startedAt,endedAt,status:200 as const,deniedStatus:401 as const};
  }));
  // Wait for every dispatched request's bounded observation before deciding.
  check();if(outcomes.some(o=>o.status==='rejected'))throw failure();
  const requests=outcomes.map(o=>(o as PromiseFulfilledResult<AuthCommitRequestWindow>).value);
  if(Math.max(...requests.map(r=>r.startedAt))>=Math.min(...requests.map(r=>r.endedAt)))throw failure();
  save('cohort-result',{at:new Date().toISOString(),requests,overlappingClientWindows:true,canonicalProofVerified:false,automaticRetry:false});
  return requests;
 }catch{throw failure();}
}
