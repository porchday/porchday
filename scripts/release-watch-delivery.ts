import {createHash} from 'node:crypto';
import {inspectReleaseWatch,listReleaseWatches} from './release-watch.ts';
import {deliverReleaseAlert} from './release-alerts.ts';
import type {GitHubTransport} from './external-monitor-github.ts';
export type WatchDeliveryState={digest:string;lastAttempt:number|null;delivered:boolean};
export type WatchDeliveryStore={read:(id:string)=>WatchDeliveryState|null;write:(id:string,value:WatchDeliveryState)=>void};
/** Caller holds the dedicated watcher lock, never the deployment lock. */
export async function pollReleaseWatches(root:string,store:WatchDeliveryStore,options:{transport?:GitHubTransport;now?:()=>number}={}){
 const now=options.now??Date.now,counts={waiting:0,completed:0,cancelled:0,pending:0,delivered:0,errors:0};
 for(const w of listReleaseWatches(root,()=>{counts.errors++;})){
  try{
   const result=await inspectReleaseWatch(w,new Date(now()));if(result.status!=='attention'){counts[result.status]++;continue;}
   const event=result.event,digest=createHash('sha256').update(JSON.stringify(event)).digest('hex'),previous=store.read(event.operationId);
   if(previous&&(previous.digest!==digest||typeof previous.delivered!=='boolean'||previous.lastAttempt!==null&&(!Number.isFinite(previous.lastAttempt)||previous.lastAttempt>now())))throw Error('RELEASE_WATCH_DELIVERY_CHANGED');
   if(previous?.delivered){counts.delivered++;continue;}
   const state=previous??{digest,lastAttempt:null,delivered:false};
   const status=await deliverReleaseAlert(event,{transport:options.transport,reconcileOnly:state.lastAttempt!==null&&now()-state.lastAttempt<60000,beforeDispatch:async()=>{
    const fresh=await inspectReleaseWatch(w,new Date(now()));if(fresh.status!=='attention'||JSON.stringify(fresh.event)!==JSON.stringify(event))throw Error('RELEASE_WATCH_NO_LONGER_PENDING');
    store.write(event.operationId,{digest,lastAttempt:now(),delivered:false});
   }});
   if(status==='delivered'){store.write(event.operationId,{...state,delivered:true});counts.delivered++;}else counts.pending++;
  }catch{counts.errors++;}
 }return counts;
}
