import type {MonitorState} from './protocol';
import type {MetricsState} from './metrics';
export const agentChannels=['availability','telemetry','latency','errors','authentication','recovery'] as const;
export function agentIncidents(state:MonitorState,metrics:MetricsState){
 return agentChannels.flatMap(channel=>{
  const s=channel==='availability'?state:metrics[channel];
  return s.incidentAt!==null&&s.status==='degraded'?[{channel,at:s.incidentAt}]:[];
 });
}
/** Human email is an independent fallback, not the ordinary incident trigger.
 * A fresh authenticated poll proves the agent-capable external receiver is up.
 * No review can erase observations or alter application/privacy enforcement. */
export function agentEmailEligible(enabled:boolean,lastSeen:number|undefined,state:MonitorState,now:number){
 if(!enabled||state.pending?.kind==='recovery')return true;
 return state.incidentAt!==null&&now-state.incidentAt>=15*60000&&(!lastSeen||now-lastSeen>120000);
}
