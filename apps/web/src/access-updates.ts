import {ApiError} from './api';
export type AccessUpdateState = 'idle' | 'sharing' | 'unconfirmed';
type Outcome = 'committed' | 'unchanged' | 'changed';
type IO<P extends {id:string}> = {
 enabled:()=>boolean;
 list:(signal:AbortSignal)=>Promise<{items:{id:string}[]}>;
 prepare:(id:string,signal:AbortSignal)=>Promise<P|null>;
 save:(candidate:P)=>Promise<void>;
 reconcile:(candidate:P,signal:AbortSignal)=>Promise<Outcome>;
 cleanup:(candidate:P)=>Promise<void>;
 state:(state:AccessUpdateState)=>void;
 changed:()=>void;
 now?:()=>number;
};
const canceled=()=>new DOMException('Sharing stopped.','AbortError');
/** A server-authorized queue, never a locally inferred audience. Keep uncertain
 * ciphertext until a read reconciles it. Retry the same bytes, not a fresh upload.
 * Every item has its own capped backoff so one unavailable key cannot stop others.
 * The caller polls and wakes on foreground/online; no work runs while locked. */
export function startAccessUpdates<P extends {id:string}>(io:IO<P>){
 let disposed=false,operation:Promise<void>|null=null,listFailures=0,listDue=0;
 const pending=new Map<string,P>(),failures=new Map<string,{attempts:number;due:number}>();
 const controllers=new Set<AbortController>(),now=io.now||Date.now;
 const current=()=>!disposed&&io.enabled();
 const publish=(state:AccessUpdateState)=>{if(!disposed)io.state(state);};
 const delay=(attempt:number)=>Math.min(300_000,5_000*2**Math.min(attempt-1,6));
 const fail=(id:string)=>{const attempts=(failures.get(id)?.attempts||0)+1;failures.set(id,{attempts,due:now()+delay(attempts)});};
 const ready=(id:string)=>(failures.get(id)?.due||0)<=now();
 async function bounded<T>(action:(signal:AbortSignal)=>Promise<T>,ms=30_000):Promise<T>{
  const controller=new AbortController();controllers.add(controller);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await new Promise<T>((resolve,reject)=>{
   const abort=()=>reject(canceled());controller.signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>controller.abort(),ms);
   Promise.resolve().then(()=>{if(!current()||controller.signal.aborted)throw canceled();return action(controller.signal);})
    .then(value=>{if(!current()||controller.signal.aborted)throw canceled();resolve(value);},reject).catch(reject)
    .finally(()=>controller.signal.removeEventListener('abort',abort));
  });}finally{clearTimeout(timer);controllers.delete(controller);}
 }
 async function reconcile(candidate:P){
  try{return await bounded(signal=>io.reconcile(candidate,signal));}
  catch(error){if(error instanceof ApiError&&[404,410].includes(error.status))return 'changed' as const;throw error;}
 }
 const complete=(id:string)=>{pending.delete(id);failures.delete(id);};
 async function process(id:string){
  let candidate=pending.get(id);
  if(candidate){
   const outcome=await reconcile(candidate);
   if(outcome!=='unchanged'){complete(id);if(outcome==='committed'&&!disposed)io.changed();return true;}
  }else{
   const prepared=await bounded(signal=>io.prepare(id,signal),10*60_000);
   if(!prepared){complete(id);return false;}
   candidate=prepared;pending.set(id,candidate);
  }
  if(!current())throw canceled();
  try{await io.save(candidate);complete(id);if(!disposed)io.changed();}
  catch(error){
   // A server commit with a lost response is success. Failed reconciliation
   // retains the prepared bytes. Never clean up media that may be attached.
   const outcome=await reconcile(candidate).catch(()=>null);
   if(outcome==='committed'){complete(id);if(!disposed)io.changed();return true;}
   if(outcome==='changed'){complete(id);return true;}
   if(outcome==='unchanged'&&error instanceof ApiError&&error.status>=400&&error.status<500){
    pending.delete(id);if(current())await io.cleanup(candidate).catch(()=>{});
   }
   throw error;
  }
  return true;
 }
 function run(){
  if(!current())return Promise.resolve();if(operation)return operation;
  const running=(async()=>{
   let queue=[...pending.keys()].filter(ready),listed:string[]|null=null;
   try{
    if(now()>=listDue){
     try{const page=await bounded(io.list);listed=page.items.map(row=>row.id);queue=[...new Set([...queue,...listed.filter(ready)])];listFailures=0;listDue=0;}
     catch(error){if(!current())throw error;listFailures++;listDue=now()+delay(listFailures);}
    }
    // At most three writes/preparations per pass. Cursor-based callers advance
    // on every page; failures reappear on the next scan, without starving pages.
    let work=0;
    for(const id of queue){
     if(work>=3)break;
     if(!current())throw canceled();publish('sharing');
     try{if(await process(id))work++;}catch(error){
      work++;
      if(!current())throw error;
      if(error instanceof ApiError&&[404,410].includes(error.status))complete(id);else fail(id);
     }
    }
    // Bounded memory for failures whose content was deleted/expired. Pending
    // writes keep their reconciliation state until resolved or this vault closes.
    for(const [id,failure]of failures)if(!pending.has(id)&&!listed?.includes(id)&&now()-failure.due>3_600_000)failures.delete(id);
    publish(failures.size||pending.size||listFailures?'unconfirmed':'idle');
   }catch{if(!disposed)publish('idle');}
  })();
  operation=running;void running.finally(()=>{if(operation===running)operation=null;});return running;
 }
 void run();
 return {recheck:run,retry:run,suspend(){for(const controller of controllers)controller.abort();},dispose(){disposed=true;for(const controller of controllers)controller.abort();}};
}
