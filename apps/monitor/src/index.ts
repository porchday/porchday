import {initialState,observe,publicStatus,probe,alertText,type MonitorState,type Environment} from './protocol';
import {renderStatusPage} from './status-page';
import {recordAvailability,availabilitySummary,type AvailabilityHistory} from './availability';
import {checkMetrics,initialMetrics,publicMetrics,metricsAlertText,type MetricsConfig,type MetricsState} from './metrics';

export interface Env extends MetricsConfig {STATE:DurableObjectNamespace;ENVIRONMENT:Environment;OPERATIONS_HEALTH_TOKEN:string;MONITOR_RECIPIENT:string;EMAIL_FROM:string;EMAIL:SendEmail}
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
      try{
        const [state,metrics,history]=await Promise.all([this.ctx.storage.get<MonitorState>('state'),this.ctx.storage.get<MetricsState>('metrics-state'),this.ctx.storage.get<AvailabilityHistory>('availability-history')]);
        const status=publicStatus(state??initialState());
        if(status.status==='operational'&&(metrics?.latency.status==='degraded'||metrics?.errors.status==='degraded'))status.status='degraded';
        return json({...status,metrics_monitoring:publicMetrics(metrics??initialMetrics()),availability:availabilitySummary(history)});
      }
      catch{return json({status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'},503);}
    }
    if(request.method!=='POST'||path!=='/tick')return json({error:'not_found'},404);
    // A single low-frequency object serializes check+state+alert work. Its own
    // timeout is bounded below blockConcurrencyWhile's platform time limit.
    return this.ctx.blockConcurrencyWhile(async()=>{
      const tick=Number(request.headers.get('X-Scheduled-Minute'));
      if(!Number.isSafeInteger(tick)||tick<0||Math.abs(tick-Math.floor(Date.now()/60000))>2)return json({error:'invalid_tick'},400);
      const old=await this.ctx.storage.get<MonitorState>('state')??initialState();
      if(tick<=old.lastTick)return json({ok:true});
      const previousMetrics=await this.ctx.storage.get<MetricsState>('metrics-state')??initialMetrics();
      // Parallel, bounded calls: health <=10s, metrics/heartbeat <=6s each.
      // Then at most one <=10s email leaves margin below the DO's 30s gate.
      const [result,metrics]=await Promise.all([probe(this.env.ENVIRONMENT,this.env.OPERATIONS_HEALTH_TOKEN),checkMetrics(previousMetrics,this.env,Date.now(),tick)]);
      const now=Date.now(),state=observe(old,result.healthy,now,tick);
      const history=recordAvailability(await this.ctx.storage.get<AvailabilityHistory>('availability-history'),tick,result.healthy);
      // Persist before any email attempt. Storage failure cannot produce an
      // untracked email storm, and never affects the separate application.
      const candidates=[{channel:'availability' as const,state},{channel:'telemetry' as const,state:metrics.telemetry},{channel:'latency' as const,state:metrics.latency},{channel:'errors' as const,state:metrics.errors},{channel:'authentication' as const,state:metrics.authentication},{channel:'recovery' as const,state:metrics.recovery}];
      const selected=candidates.find(item=>item.state.pending&&item.state.pending.nextAttemptAt<=now);
      const pending=selected?.state.pending;
      const send=!!pending&&pending.nextAttemptAt<=now;
      if(send){pending!.attempts++;pending!.nextAttemptAt=now+Math.min(3600000,300000*2**Math.min(pending!.attempts-1,4));}
      await this.ctx.storage.put({'state':state,'metrics-state':metrics,'availability-history':history});
      if(send){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          if(!this.env.EMAIL||!this.env.MONITOR_RECIPIENT||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(this.env.MONITOR_RECIPIENT)||/[\r\n]/.test(this.env.EMAIL_FROM))throw Error('MONITOR_MAIL_CONFIGURATION');
          const text=selected!.channel==='availability'?alertText(this.env.ENVIRONMENT,pending!.kind):metricsAlertText(this.env.ENVIRONMENT,selected!.channel,pending!.kind);
          await Promise.race([this.env.EMAIL.send({from:this.env.EMAIL_FROM,to:this.env.MONITOR_RECIPIENT,...text}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('MONITOR_MAIL_TIMEOUT')),10000);})]);
          const alertState=selected!.state;
          if(pending!.kind==='outage'){alertState.outageDelivered=true;alertState.lastDeliveredAt=now;}
          else{alertState.outageDelivered=false;alertState.incidentAt=null;alertState.lastDeliveredAt=null;}
          alertState.pending=null;await this.ctx.storage.put({'state':state,'metrics-state':metrics});
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
    try{
      const response=await stub(env).fetch('https://monitor.internal/status');
      return path==='/status'?response:renderStatusPage(await response.json(),response.status);
    }catch{
      const unavailable={status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'};
      return path==='/status'?json(unavailable,503):renderStatusPage(unavailable,503);
    }
  },
  async scheduled(controller:ScheduledController,env:Env):Promise<void>{
    try{
      const response=await stub(env).fetch('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor(controller.scheduledTime/60000))}});
      if(!response.ok)throw Error('MONITOR_CHECK_FAILED');
    }catch{console.log(JSON.stringify({event:'monitor',code:'check_failed',environment:env.ENVIRONMENT}));}
  },
} satisfies ExportedHandler<Env>;
