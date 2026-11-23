import {readStatus} from './read-status';
import {agentIncidents,agentEmailEligible} from './agent-inbox';
import {initialState,observe,publicStatus,probe,alertText,type MonitorState,type Environment} from './protocol';
import {renderStatusPage} from './status-page';
import {recordAvailability,availabilitySummary,type AvailabilityHistory} from './availability';
import {checkMetrics,initialMetrics,publicMetrics,metricsAlertText,type MetricsConfig,type MetricsState} from './metrics';

export interface Env extends MetricsConfig {STATE:DurableObjectNamespace;ENVIRONMENT:Environment;OPERATIONS_HEALTH_TOKEN:string;MONITOR_RECIPIENT:string;EMAIL_FROM:string;EMAIL:SendEmail;AGENT_FIRST_ALERTS?:string}
const headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const stub=(env:Env)=>env.STATE.get(env.STATE.idFromName('monitor-v1'));

/** Only the scheduled handler can reach /tick; the public fetch handler never
 * forwards caller paths, methods, URLs or headers to this object. */
export class Monitor {
  constructor(private ctx:DurableObjectState,private env:Env){}
  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/agent-signal'&&request.method==='POST'){
      if(this.env.AGENT_FIRST_ALERTS!=='true')return json({error:'not_enabled'},404);
      return this.ctx.blockConcurrencyWhile(async()=>{
        const signal=await request.json() as {id:string;at:string;kind:string;failedChecks:string[]};
        const previous=await this.ctx.storage.get<{at:string}>('agent-backup-signal');
        if(!previous||Date.parse(signal.at)>Date.parse(previous.at))await this.ctx.storage.put('agent-backup-signal',signal);
        const seen=await this.ctx.storage.get<number>('agent-last-seen');
        return json({accepted:true,receiverReady:!!seen&&Date.now()-seen<=120000});
      });
    }
    if(path==='/agent-inbox'&&['GET','POST'].includes(request.method)){
      if(this.env.AGENT_FIRST_ALERTS!=='true')return json({error:'not_enabled'},404);
      return this.ctx.blockConcurrencyWhile(async()=>{
        if(request.method==='POST'){
          const body=await request.json() as {ready?:unknown};
          if(typeof body.ready!=='boolean')return json({error:'invalid_poll'},400);
          await this.ctx.storage.put('agent-last-seen',body.ready?Date.now():0);
        }
        const state=await this.ctx.storage.get<MonitorState>('state')??initialState(),metrics=await this.ctx.storage.get<MetricsState>('metrics-state')??initialMetrics();
        return json({enabled:true,lastAgentSeenAt:await this.ctx.storage.get<number>('agent-last-seen')??null,incidents:agentIncidents(state,metrics),backupSignal:await this.ctx.storage.get('agent-backup-signal')??null});
      });
    }
    if(request.method==='GET'&&path==='/status'){
      try{
        const [state,metrics,history]=await Promise.all([this.ctx.storage.get<MonitorState>('state'),this.ctx.storage.get<MetricsState>('metrics-state'),this.ctx.storage.get<AvailabilityHistory>('availability-history')]);
        const status=publicStatus(state??initialState());
        if(status.status==='operational'&&(metrics?.latency.status==='degraded'||metrics?.errors.status==='degraded'))status.status='degraded';
        return json({...status,metrics_monitoring:publicMetrics(metrics??initialMetrics()),availability:availabilitySummary(history)});
      }
      catch{if(this.env.ENVIRONMENT==='staging')console.log(JSON.stringify({event:'monitor',code:'status_storage_read_failed',environment:this.env.ENVIRONMENT}));return json({status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'},503);}
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
      let lastAgentSeen=await this.ctx.storage.get<number>('agent-last-seen');
      if(this.env.AGENT_FIRST_ALERTS==='true'&&lastAgentSeen===undefined){lastAgentSeen=now;await this.ctx.storage.put('agent-last-seen',0);}
      const selected=candidates.find(item=>item.state.pending&&item.state.pending.nextAttemptAt<=now&&agentEmailEligible(this.env.AGENT_FIRST_ALERTS==='true',lastAgentSeen,item.state,now));
      const pending=selected?.state.pending;
      const send=!!pending&&pending.nextAttemptAt<=now;
      if(send){pending!.attempts++;pending!.nextAttemptAt=now+Math.min(3600000,300000*2**Math.min(pending!.attempts-1,4));}
      await this.ctx.storage.put({'state':state,'metrics-state':metrics,'availability-history':history});
      if(send){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          if(!this.env.EMAIL||!this.env.MONITOR_RECIPIENT||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(this.env.MONITOR_RECIPIENT)||/[\r\n]/.test(this.env.EMAIL_FROM))throw Error('MONITOR_MAIL_CONFIGURATION');
          let text=selected!.channel==='availability'?alertText(this.env.ENVIRONMENT,pending!.kind):metricsAlertText(this.env.ENVIRONMENT,selected!.channel,pending!.kind);
          if(this.env.AGENT_FIRST_ALERTS==='true'&&pending!.kind==='outage')text={subject:`Porchday ${this.env.ENVIRONMENT}: automated investigation unavailable`,text:'The independent agent receiver has not checked in recently and this incident has remained unresolved for at least 15 minutes. This is a fallback notification, not a completed agent assessment.\n\n'+text.text};
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
    if((path==='/agent-inbox'&&['GET','POST'].includes(request.method)||path==='/agent-signal'&&request.method==='POST')){
      if(env.AGENT_FIRST_ALERTS!=='true'||!env.OPERATIONS_HEALTH_TOKEN||env.OPERATIONS_HEALTH_TOKEN.length<32||request.headers.get('Authorization')!=='Bearer '+env.OPERATIONS_HEALTH_TOKEN)return json({error:'not_found'},404);
      if(request.method==='POST'){
        const reader=request.body?.getReader();if(!reader)return json({error:'invalid_poll'},400);let text='';try{for(;;){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);if(text.length>2048)return json({error:'invalid_poll'},400);}}finally{await reader.cancel();}
        let body:any;try{body=JSON.parse(text);}catch{return json({error:'invalid_poll'},400);}
        if(path==='/agent-signal'){
          const allowed=['protected_readiness','anonymous_session','legacy_anonymous_session','monitor_freshness','login','authorized_profile','authorized_feed','logout','revocation','backup_execution'];
          if(!body||typeof body.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(body.id)||!['outage','recovery'].includes(body.kind)||typeof body.at!=='string'||!Number.isFinite(Date.parse(body.at))||Math.abs(Date.now()-Date.parse(body.at))>20*60000||!Array.isArray(body.failedChecks)||body.failedChecks.length>10||body.failedChecks.some((c:unknown)=>typeof c!=='string'||!allowed.includes(c)))return json({error:'invalid_signal'},400);
          return stub(env).fetch('https://monitor.internal/agent-signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:body.id,at:body.at,kind:body.kind,failedChecks:body.failedChecks})});
        }
        if(!body||Object.keys(body).join(',')!=='ready'||typeof body.ready!=='boolean')return json({error:'invalid_poll'},400);
        return stub(env).fetch('https://monitor.internal/agent-inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      }
      return stub(env).fetch('https://monitor.internal/agent-inbox');
    }
    if(request.method!=='GET'||!['/','/status'].includes(path))return json({error:'not_found'},404);
    try{
      const response=env.ENVIRONMENT==='staging'?await readStatus(env.STATE):await stub(env).fetch('https://monitor.internal/status');
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
