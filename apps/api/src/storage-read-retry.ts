import {causalSpan} from './causal-tracing';
import type {JournalStore} from './privacy-journal';

/** Retry only rejected lookups/body reads, never writes, missing records or
 * validation failures. All attempts share the original two-second budget.
 * Late reads cannot start a body read/retry or become an authorization result.
 * No cached authority is used; every attempt consults the backing store. */
export async function readStorageText(store:Pick<JournalStore,'get'>,key:string){
 const until=performance.now()+2000;let closed=false,timer:ReturnType<typeof setTimeout>|undefined;
 const unavailable=()=>Error('STORAGE_READ_UNAVAILABLE');
 const assertOpen=()=>{if(closed||performance.now()>=until)throw unavailable();};
 const work=async()=>{
  for(let attempt=0;attempt<3;attempt++){
   assertOpen();
   try{
    const object=await store.get(key);assertOpen();if(!object)return null;
    const text=await object.text();assertOpen();return {etag:object.etag,text:async()=>text};
   }catch{
    assertOpen();if(attempt===2)throw unavailable();
    const delay=50*2**attempt+Math.floor(Math.random()*50);
    if(performance.now()+delay>=until)throw unavailable();
    await causalSpan('storage.read_retry',()=>new Promise(resolve=>setTimeout(resolve,delay)));
   }
  }
  throw unavailable();
 };
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{closed=true;reject(unavailable());},2000);})]);}
 finally{closed=true;if(timer!==undefined)clearTimeout(timer);}
}
