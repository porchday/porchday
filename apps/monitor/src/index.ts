import {initialState,observe,publicStatus,probe,alertText,type MonitorState,type Environment} from './protocol';

export interface Env {STATE:DurableObjectNamespace;ENVIRONMENT:Environment;OPERATIONS_HEALTH_TOKEN:string;MONITOR_RECIPIENT:string;EMAIL_FROM:string;EMAIL:SendEmail}
const headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const stub=(env:Env)=>env.STATE.get(env.STATE.idFromName('monitor-v1'));

/** Only the scheduled handler can reach /tick; the public fetch handler never
 * forwards caller paths, methods, URLs or headers to this object. */
export class Monitor {
  constructor(private ctx:DurableObjectState,private env:Env){}
  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/status'){
      try{return json(publicStatus(await this.ctx.storage.get<MonitorState>('state')??initialState()));}
      catch{return json({status:'unknown',last_checked_at:null},503);}
    }
    if(request.method!=='POST'||path!=='/tick')return json({error:'not_found'},404);
    // A single low-frequency object serializes check+state+alert work. Its own
    // timeout is bounded below blockConcurrencyWhile's platform time limit.
    return this.ctx.blockConcurrencyWhile(async()=>{
      const tick=Number(request.headers.get('X-Scheduled-Minute'));
      if(!Number.isSafeInteger(tick)||tick<0||Math.abs(tick-Math.floor(Date.now()/60000))>2)return json({error:'invalid_tick'},400);
      const old=await this.ctx.storage.get<MonitorState>('state')??initialState();
      if(tick<=old.lastTick)return json({ok:true});
      const result=await probe(this.env.ENVIRONMENT,this.env.OPERATIONS_HEALTH_TOKEN);
      const now=Date.now(),state=observe(old,result.healthy,now,tick);
      // Persist before any email attempt. Storage failure cannot produce an
      // untracked email storm, and never affects the separate application.
      const pending=state.pending;
      const send=!!pending&&pending.nextAttemptAt<=now;
      if(send){pending!.attempts++;pending!.nextAttemptAt=now+Math.min(3600000,300000*2**Math.min(pending!.attempts-1,4));}
      await this.ctx.storage.put('state',state);
      if(send){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          if(!this.env.EMAIL||!this.env.MONITOR_RECIPIENT||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(this.env.MONITOR_RECIPIENT)||/[\r\n]/.test(this.env.EMAIL_FROM))throw Error('MONITOR_MAIL_CONFIGURATION');
          await Promise.race([this.env.EMAIL.send({from:this.env.EMAIL_FROM,to:this.env.MONITOR_RECIPIENT,...alertText(this.env.ENVIRONMENT,pending!.kind)}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('MONITOR_MAIL_TIMEOUT')),10000);})]);
          if(pending!.kind==='outage'){state.outageDelivered=true;state.lastDeliveredAt=now;}
          else{state.outageDelivered=false;state.incidentAt=null;state.lastDeliveredAt=null;}
          state.pending=null;await this.ctx.storage.put('state',state);
        }catch{console.log(JSON.stringify({event:'monitor',code:'alert_retry',environment:this.env.ENVIRONMENT}));}
        finally{if(timer)clearTimeout(timer);}
      }
      return json({ok:true});
    });
  }
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(request.method!=='GET'||!['/','/status'].includes(path))return json({error:'not_found'},404);
    try{return await stub(env).fetch('https://monitor.internal/status');}
    catch{return json({status:'unknown',last_checked_at:null},503);}
  },
  async scheduled(controller:ScheduledController,env:Env):Promise<void>{
    try{
      const response=await stub(env).fetch('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor(controller.scheduledTime/60000))}});
      if(!response.ok)throw Error('MONITOR_CHECK_FAILED');
    }catch{console.log(JSON.stringify({event:'monitor',code:'check_failed',environment:env.ENVIRONMENT}));}
  },
} satisfies ExportedHandler<Env>;
