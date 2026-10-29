// Test-only subprocess. Inputs arrive over IPC, never command arguments/logs.
import {Pool} from 'pg';
import {publishSessionDenial} from '../../src/session-denial.ts';
import {deleteDeniedSession} from '../../src/session-denial-cleanup.ts';
import {sweepSessionCandidates,listSessionCandidates,candidateProgressKey,parseCandidateProgress} from '../../src/session-denial-candidates.ts';
import type {JournalStore} from '../../src/privacy-journal.ts';
process.once('message',async(input:{action:'publish'|'cleanup';url:string;bearer:string;sessionId:string;database:string})=>{
 let pool:Pool|undefined;
 try{
  const call=async(operation:string,args:unknown[])=>{
   const response=await fetch(input.url,{method:'POST',headers:{Authorization:'Bearer '+input.bearer,'Content-Type':'application/json'},body:JSON.stringify({operation,args}),signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw Error('TEST_STORE_UNAVAILABLE');return response.json();
  };
  const store:JournalStore={
   get:async key=>{const row=await call('get',[key]);return row?{etag:row.etag,text:async()=>row.value}:null;},
   put:(...args)=>call('put',args),
  };
  if(input.action==='publish'){
   await publishSessionDenial({RECOVERY_JOURNAL:store as unknown as R2Bucket},input.sessionId);
   process.send?.({phase:'denial-confirmed'});
   // Deterministic crash boundary: no SQL connection or cleanup has begun.
   setInterval(()=>{},1000);
  }else{
   pool=new Pool({connectionString:input.database,max:1});
   const result={seen:0,deleted:0,invalid:0};let complete=false;
   for(let page=0;page<10;page++){
    const current=await sweepSessionCandidates(store,after=>listSessionCandidates(pool!,after),id=>deleteDeniedSession(pool!,id));
    result.seen+=current.seen;result.deleted+=current.deleted;result.invalid+=current.invalid;
    const progress=await store.get(candidateProgressKey);
    if(progress&&parseCandidateProgress(await progress.text()).cursor===null){complete=true;break;}
   }
   if(!complete)throw Error('TEST_PASS_INCOMPLETE');
   await pool.end();pool=undefined;process.send?.({phase:'cleanup-complete',result});process.disconnect();
  }
 }catch{await pool?.end().catch(()=>{});process.send?.({phase:'failed'});process.exitCode=1;process.disconnect();}
});
