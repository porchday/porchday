export interface MonitorState {
  v:1; lastTick:number; checkedAt:number|null; status:'checking'|'operational'|'degraded'; failures:number; successes:number;
  incidentAt:number|null; outageDelivered:boolean; lastDeliveredAt:number|null;
  pending:{kind:'outage'|'recovery';attempts:number;nextAttemptAt:number}|null;
}
export const initialState=():MonitorState=>({v:1,lastTick:-1,checkedAt:null,status:'checking',failures:0,successes:0,incidentAt:null,outageDelivered:false,lastDeliveredAt:null,pending:null});
export type Environment='staging'|'production';
export interface ProbeResult {healthy:boolean}
export async function probe(environment:Environment,token:string,request:typeof fetch=fetch):Promise<ProbeResult> {
  if(!['staging','production'].includes(environment)||!token||token.length<32||token.length>256)return{healthy:false};
  const host=environment==='production'?'porchday.com':'staging.porchday.com';
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    // Race also bounds injected/misbehaving transports that ignore AbortSignal.
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PROBE_TIMEOUT'));},10000);});
    return await Promise.race([timeout,(async()=>{
      const response=await request(`https://${host}/api/operations/health`,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:controller.signal});
      if(response.status!==200){await response.body?.cancel();return{healthy:false};}
      // Bound response bytes and never persist/log the protected diagnostics.
      const reader=response.body?.getReader();if(!reader)return{healthy:false};
      const decoder=new TextDecoder();let content='',size=0;
      try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();return{healthy:false};}content+=decoder.decode(part.value,{stream:true});}content+=decoder.decode();}
      finally {reader.releaseLock();}
      const value=JSON.parse(content) as {status?:unknown;issues?:unknown;snapshot?:unknown};
      return{healthy:value.status==='ok'&&Array.isArray(value.issues)&&value.issues.length===0&&!!value.snapshot&&typeof value.snapshot==='object'&&!Array.isArray(value.snapshot)};
    })()]);
  } catch {return{healthy:false};} finally {if(timer)clearTimeout(timer);controller.abort();}
}
export function observe(previous:MonitorState,healthy:boolean,now:number,tick:number):MonitorState {
  const state=structuredClone(previous);state.lastTick=tick;state.checkedAt=now;
  if(healthy){
    state.failures=0;state.successes=Math.min(2,state.successes+1);
    if(state.status==='checking')state.status='operational';
    if(state.status==='degraded'&&state.successes>=2){
      state.status='operational';
      state.pending=state.outageDelivered?{kind:'recovery',attempts:0,nextAttemptAt:now}:null;
      if(!state.outageDelivered){state.incidentAt=null;state.lastDeliveredAt=null;}
    }
  }else{
    state.successes=0;state.failures=Math.min(3,state.failures+1);
    if(state.failures>=3&&state.status!=='degraded'){
      state.status='degraded';state.incidentAt=now;state.outageDelivered=false;state.lastDeliveredAt=null;
      state.pending={kind:'outage',attempts:0,nextAttemptAt:now};
    }
  }
  if(state.status==='degraded'&&!state.pending&&state.outageDelivered&&state.lastDeliveredAt!==null&&now-state.lastDeliveredAt>=6*3600000)state.pending={kind:'outage',attempts:0,nextAttemptAt:now};
  return state;
}
export function publicStatus(state:MonitorState,now=Date.now()) {
  return {status:state.checkedAt===null||now-state.checkedAt>180000?'unknown':state.status,last_checked_at:state.checkedAt===null?null:new Date(state.checkedAt).toISOString()};
}
export function alertText(environment:Environment,kind:'outage'|'recovery') {
  return {subject:`Porchday ${environment}: ${kind==='outage'?'service needs attention':'service recovered'}`,text:kind==='outage'
    ?`Porchday ${environment} failed at least three consecutive operational checks. Inspect the private operations dashboard and restore quarantine state. This alert contains no member information. Further outage reminders are limited to once every six hours after successful delivery.`
    :`Porchday ${environment} passed two consecutive operational checks after an incident. The service monitor is reporting recovery. This alert contains no member information.`};
}
