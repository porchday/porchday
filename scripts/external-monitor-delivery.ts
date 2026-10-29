import {deliver,type GitHubTransport} from './external-monitor-github.ts';
import type {AlertState} from './external-monitor-alerts.ts';
/** Read-back polling is independent of probes and the durable 60-second POST cooldown. */
export function createRelayDrainer(options:{issue:number;drill?:boolean;read:()=>AlertState;write:(state:AlertState)=>void;stopping:()=>boolean;notify:(event:'notification_pending'|'notification_delivered',kind?:'outage'|'recovery')=>void;now?:()=>number;transport?:GitHubTransport}){
 const now=options.now??Date.now;let inFlight:Promise<void>|undefined,retryReadAfter=0;
 async function drain(){
  while(options.read().pending.length&&!options.stopping()){
   const event=options.read().pending[0],last=options.read().lastRelayAttempt;
   const reconcileOnly=!!last&&last.id===event.id&&now()-Date.parse(last.at)<60000;
   try{
    await deliver(options.issue,event,'operator-mac',{relay:true,drill:options.drill,reconcileOnly,transport:options.transport,beforeRelayDispatch:()=>{
     if(options.stopping())throw Error('MONITOR_STOPPING');
     const state=options.read();if(state.pending[0]?.id!==event.id)throw Error('MONITOR_OUTBOX_CHANGED');
     // Persist before dispatch: a restart must reconcile an uncertain POST first.
     options.write({...state,lastRelayAttempt:{id:event.id,at:new Date(now()).toISOString()}});
    }});
    const current=options.read(),next={...current,pending:current.pending.filter(candidate=>candidate.id!==event.id)};
    if(next.lastRelayAttempt?.id===event.id)delete next.lastRelayAttempt;
    options.write(next);options.notify('notification_delivered',event.kind);
   }catch{
    // GET failures do not consume the POST cooldown. Uncertain POSTs do.
    retryReadAfter=now()+5000;options.notify('notification_pending');return;
   }
  }
 }
 return{flush():Promise<void>{
  if(inFlight)return inFlight;
  if(options.stopping()||now()<retryReadAfter||!options.read().pending.length)return Promise.resolve();
  inFlight=drain().finally(()=>{inFlight=undefined;});return inFlight;
 }};
}
