import {journalDeadline,JournalDeadlineError} from './journal-deadline';
import type {JournalDatabase,JournalStore} from './privacy-journal';

export const JOURNAL_IO_CODES=['journal_r2_read_retry','journal_r2_write_retry','journal_db_capacity_retry','journal_db_connection_retry','journal_io_exhausted','journal_io_deadline'] as const;
type Code=typeof JOURNAL_IO_CODES[number];
type Options={deadlineEnabled?:boolean;report:(code:Code)=>void;sleep?:(ms:number)=>Promise<void>;now?:()=>number;random?:()=>number};

/** Retry transport operations, never application work or safety decisions.
 * One small budget is shared across a request's journal resources. Conditional
 * writes retain the identical bytes and precondition: a lost successful reply
 * becomes a CAS miss, which the existing protocol rereads/reconciles. A fresh
 * receipt/checkpoint must never be fabricated by replaying the user's action.
 */
export function resilientJournalIO(store:JournalStore,db:JournalDatabase,options:Options){
 const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),now=options.now??Date.now,random=options.random??Math.random;
 const deadline=options.deadlineEnabled===false?{run:<T>(work:(scope:{assertOpen:()=>void})=>Promise<T>)=>work({assertOpen:()=>{}})}:journalDeadline({attemptMs:5000,totalMs:30000});
 let retries=0,firstFailure:number|undefined;
 const report=(code:Code)=>{try{options.report(code);}catch{/* Telemetry cannot affect durability. */}};
 async function retry<T>(operation:()=>Promise<T>,classify:(error:unknown)=>Code|undefined):Promise<T>{
  for(;;){
   const started=now();
   try{return await operation();}
   catch(error){
    if(error instanceof JournalDeadlineError){report('journal_io_deadline');throw error;}
    const code=classify(error);if(!code)throw error;
    firstFailure??=started;
    const delay=1000*2**retries+Math.floor(random()*250);
    if(retries>=3||now()-firstFailure+delay>10000){report('journal_io_exhausted');throw error;}
    retries++;report(code);await deadline.run(async scope=>{await sleep(delay);scope.assertOpen();});
   }
  }
 }
 function databaseFailure(error:unknown):Code|undefined{
  // Inspect only a finite code, never copy messages, SQL, URLs or parameters.
  const code=(error as {code?:unknown}|null)?.code;
  if(code==='53300')return 'journal_db_capacity_retry';
  if(typeof code==='string'&&(/^(08000|08001|08003|08004|08006|08007|08P01)$/.test(code)||['57P01','57P02','57P03','ECONNRESET','ECONNREFUSED','ETIMEDOUT','CONNECTION_CLOSED','CONNECTION_ENDED','CONNECT_TIMEOUT'].includes(code)))return 'journal_db_connection_retry';
 }
 return {
  store:{
   async get(key){
    // Include reading the body; it may fail after the object lookup succeeds.
    return retry(()=>deadline.run(async scope=>{const object=await store.get(key);scope.assertOpen();if(!object)return null;const text=await object.text();scope.assertOpen();return {etag:object.etag,text:async()=>text};}),()=> 'journal_r2_read_retry');
   },
   async put(key,value,condition){
    if(!condition?.onlyIf?.etagMatches&&condition?.onlyIf?.etagDoesNotMatch!=='*')return deadline.run(()=>store.put(key,value,condition));
    // Clone the condition once so a caller cannot change it between attempts.
    const pinned={onlyIf:{...condition.onlyIf}};
    return retry(()=>deadline.run(()=>store.put(key,value,pinned)),()=> 'journal_r2_write_retry');
   },
  } satisfies JournalStore,
  db:{
   // Preparation/recovery can commit metadata. Bound waiting without replaying
   // an uncertain database mutation; later recovery uses its exact identity.
   ...(db.prepareAuth?{prepareAuth:(scope:Parameters<NonNullable<JournalDatabase['prepareAuth']>>[0])=>deadline.run(()=>db.prepareAuth!(scope))}:{}),
   ...(db.recoverAuth?{recoverAuth:(scope:Parameters<NonNullable<JournalDatabase['recoverAuth']>>[0])=>deadline.run(()=>db.recoverAuth!(scope))}:{}),
   status:()=>retry(()=>deadline.run(()=>db.status()),databaseFailure),page:(after)=>retry(()=>deadline.run(()=>db.page(after)),databaseFailure)} satisfies JournalDatabase,
 };
}
