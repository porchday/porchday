import type {Observation} from './external-monitor-probe.ts';

export const checkNames = ['protected_readiness','anonymous_session','legacy_anonymous_session','monitor_freshness','login','authorized_profile','authorized_feed','logout','revocation','backup_execution'] as const;
export type AlertEvent = {id:string;kind:'outage'|'recovery';at:string;failedChecks:string[]};
export type AlertState = {v:1;incident:boolean;healthyStreak:number;lastAt:string|null;pending:AlertEvent[];lastRelayAttempt?:{id:string;at:string}};
export const initialState = ():AlertState=>({v:1,incident:false,healthyStreak:0,lastAt:null,pending:[]});

/** Reduce only validated, fixed-format observations. No response bodies enter the outbox. */
export function advance(state:AlertState, observation:Observation, eventId:string):AlertState {
 if(!Number.isFinite(Date.parse(observation.at)) || !/^[a-zA-Z0-9-]{1,64}$/.test(eventId)
  || observation.checks.some(c=>!checkNames.includes(c.name as typeof checkNames[number]))) throw Error('INVALID_MONITOR_OBSERVATION');
 if(state.lastAt!==null && Date.parse(observation.at)<=Date.parse(state.lastAt)) return state;
 const next:AlertState={...state,pending:[...state.pending],lastAt:observation.at};
 if(!observation.healthy){
  next.healthyStreak=0;
  if(!state.incident){
   next.incident=true;
   next.pending.push({id:eventId,kind:'outage',at:observation.at,failedChecks:observation.checks.filter(c=>!c.ok).map(c=>c.name).sort()});
  }
 } else {
  // A gap breaks the recovery streak; missing checks are not successful checks.
  const consecutive=state.lastAt!==null && Date.parse(observation.at)-Date.parse(state.lastAt)<=45000;
  next.healthyStreak=Math.min(2,(consecutive?state.healthyStreak:0)+1);
  if(state.incident && next.healthyStreak>=2){
   next.incident=false;
   next.pending.push({id:eventId,kind:'recovery',at:observation.at,failedChecks:[]});
  }
 }
 return next;
}

export function alertBody(event:AlertEvent, source:'operator-mac'|'github-backup', drill=false):string {
 if(!/^[a-zA-Z0-9-]{1,64}$/.test(event.id)||!Number.isFinite(Date.parse(event.at))
  ||!['outage','recovery'].includes(event.kind)||event.failedChecks.some(c=>!checkNames.includes(c as typeof checkNames[number])))throw Error('INVALID_MONITOR_EVENT');
 const marker=`<!-- porchday-external-monitor:${source}:${event.id} -->`;
 return `${marker}\n${drill?'**Notification drill — no production outage was induced.**\n\n':''}@andyk @bobbyhwilder\n\n${event.kind==='outage'?'External availability check failed.':'External availability checks recovered.'}\n\nObserved at: ${new Date(event.at).toISOString()}\nMonitor: ${source}\n${event.kind==='outage'?`Failed checks: ${event.failedChecks.join(', ')}\n`:''}\nScope: synthetic login, authorized reads, logout/revocation and protected readiness. This does not verify encrypted writes or establish the monthly SLO.\n\nFollow [the reliability runbook](https://github.com/porchday/porchday/blob/main/docs/reliability.md). Do not clear privacy quarantine without independent recovery evidence.`;
}
