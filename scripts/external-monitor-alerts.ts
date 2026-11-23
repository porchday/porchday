import type {Observation} from './external-monitor-probe.ts';

export const checkNames = ['protected_readiness','anonymous_session','legacy_anonymous_session','monitor_freshness','login','authorized_profile','authorized_feed','logout','revocation','backup_execution','incident_dispatch'] as const;
export type AlertEvent = {id:string;kind:'outage'|'recovery';at:string;failedChecks:string[];notAttemptedChecks?:string[];notice?:'service'|'monitoring'};
export type AlertState = {v:1;incident:boolean;healthyStreak:number;healthySince?:string;failureStreak?:number;firstFailureAt?:string;observedFailures?:string[];observedDependencies?:string[];lastAt:string|null;pending:AlertEvent[];incidentNotice?:'service'|'monitoring';lastDispatchNoticeAt?:string;lastRelayAttempt?:{id:string;at:string}};
export const initialState = ():AlertState=>({v:1,incident:false,healthyStreak:0,lastAt:null,pending:[]});

/** Reduce only validated, fixed-format observations. No response bodies enter the outbox. */
export function advance(state:AlertState, observation:Observation, eventId:string):AlertState {
 if(!Number.isFinite(Date.parse(observation.at)) || !/^[a-zA-Z0-9-]{1,64}$/.test(eventId)
  || observation.checks.some(c=>!checkNames.includes(c.name as typeof checkNames[number]))) throw Error('INVALID_MONITOR_OBSERVATION');
 if(state.lastAt!==null && Date.parse(observation.at)<=Date.parse(state.lastAt)) return state;
 const next:AlertState={...state,pending:[...state.pending],lastAt:observation.at};
 if(!observation.healthy){
  next.healthyStreak=0;
  delete next.healthySince;
  const contiguous=state.lastAt!==null&&Date.parse(observation.at)-Date.parse(state.lastAt)<=45000;
  next.failureStreak=Math.min(2,(contiguous?(state.failureStreak||0):0)+1);
  next.firstFailureAt=contiguous&&state.failureStreak?state.firstFailureAt||observation.at:observation.at;
  const previous=contiguous&&state.failureStreak;
  next.observedFailures=[...new Set([...(previous?state.observedFailures??[]:[]),...observation.checks.filter(c=>!c.ok&&c.failure!=='dependency').map(c=>c.name)])].sort();
  next.observedDependencies=[...new Set([...(previous?state.observedDependencies??[]:[]),...observation.checks.filter(c=>!c.ok&&c.failure==='dependency').map(c=>c.name)])].filter(name=>!next.observedFailures!.includes(name)).sort();
  if(!state.incident&&next.failureStreak>=2){
   next.incident=true;
   next.pending.push({id:eventId,kind:'outage',at:next.firstFailureAt!,failedChecks:next.observedFailures,notAttemptedChecks:next.observedDependencies});
  }
 } else {
  next.failureStreak=0;delete next.firstFailureAt;delete next.observedFailures;delete next.observedDependencies;
  // A gap breaks the recovery streak; missing checks are not successful checks.
  const consecutive=state.lastAt!==null && Date.parse(observation.at)-Date.parse(state.lastAt)<=45000;
  next.healthyStreak=Math.min(2,(consecutive?state.healthyStreak:0)+1);
  if(!consecutive||!next.healthySince)next.healthySince=observation.at;
  if(state.incident && next.healthyStreak>=2 && Date.parse(observation.at)-Date.parse(next.healthySince)>=140000){
   next.incident=false;
   next.pending.push({id:eventId,kind:'recovery',at:observation.at,failedChecks:[]});
  }
 }
 return next;
}

export function alertBody(event:AlertEvent, source:'operator-mac'|'github-backup', drill=false):string {
 if(!/^[a-zA-Z0-9-]{1,64}$/.test(event.id)||!Number.isFinite(Date.parse(event.at))
  ||!['outage','recovery'].includes(event.kind)||event.failedChecks.some(c=>!checkNames.includes(c as typeof checkNames[number]))||event.notAttemptedChecks!==undefined&&(!Array.isArray(event.notAttemptedChecks)||event.notAttemptedChecks.some(c=>!checkNames.includes(c as typeof checkNames[number])||event.failedChecks.includes(c))))throw Error('INVALID_MONITOR_EVENT');
 if(event.notice!==undefined&&!['service','monitoring'].includes(event.notice))throw Error('INVALID_MONITOR_EVENT');
 const marker=`<!-- porchday-external-monitor:${source}:${event.id} -->`;
 return `${marker}\n${drill?'**Notification drill — no production outage was induced.**\n\n':''}@andyk @bobbyhwilder\n\n${event.notice==='monitoring'?(event.kind==='outage'?'Monitoring needs attention; application downtime is not established.':'Monitoring checks recovered.'):(event.kind==='outage'?'External availability check failed.':'External availability checks recovered.')}${event.notice?'\nNotice: '+event.notice:''}\n\nObserved at: ${new Date(event.at).toISOString()}\nMonitor: ${source}\n${event.kind==='outage'?`Failed checks: ${event.failedChecks.join(', ')}\n${event.notAttemptedChecks===undefined?'':`Not attempted after an earlier failure: ${event.notAttemptedChecks.join(', ')||'none'}\n`}`:''}\nScope: synthetic login, authorized reads, logout/revocation and protected readiness. This does not verify encrypted writes or establish the monthly SLO.\n\nFollow [the reliability runbook](https://github.com/porchday/porchday/blob/main/docs/reliability.md). Do not clear privacy quarantine without independent recovery evidence.`;
}

/** Paging policy is separate from append-only diagnostic/SLO observations.
 * HTTP failures retain fast confirmation. A single vantage point's transport
 * failures need two minutes; monitor-only failures need ten. Security failures
 * after an acknowledged logout are immediate. No request timeout is changed.
 */
export function advanceActionable(state:AlertState, observation:Observation, eventId:string):AlertState {
 const failed=observation.checks.filter(c=>!c.ok&&c.failure!=='dependency');
 const service=failed.filter(c=>!['monitor_freshness','backup_execution','incident_dispatch'].includes(c.name));
 const security=observation.checks.some(c=>c.name==='logout'&&c.ok)&&failed.some(c=>c.name==='revocation'&&c.status===200);
 const monitoring=failed.length>0&&service.length===0;
 const delay=security?0:monitoring?600000:service.some(c=>typeof c.status==='number')?0:120000;
 // Unknown/incomplete observations never become evidence of recovery.
 const seeded=security&&!state.incident?{...state,failureStreak:1,lastAt:new Date(Date.parse(observation.at)-1).toISOString()}:state;
 let next=advance(seeded,observation,eventId);
 if(next===seeded)return state;
 const created=next.pending.length>state.pending.length?next.pending.at(-1):undefined;
 if(created?.kind==='outage'&&!state.incident){
  const elapsed=Date.parse(observation.at)-Date.parse(next.firstFailureAt??observation.at);
  if(!security&&elapsed<delay){next={...next,incident:false,pending:next.pending.slice(0,-1)};}
  else{next.incidentNotice=monitoring?'monitoring':'service';created.notice=next.incidentNotice;}
 }else if(created?.kind==='recovery'){
  created.notice=state.incidentNotice;delete next.incidentNotice;
 }
 return next;
}

/** Dispatch errors are not a second application outage. Coalesce while an
 * application incident is already notified, and rate-limit standalone notices.
 */
export function dispatchAttention(state:AlertState,at:string,id:string):AlertState {
 if(state.incident||state.lastDispatchNoticeAt&&Date.parse(at)-Date.parse(state.lastDispatchNoticeAt)<3600000)return state;
 const event:AlertEvent={id,kind:'outage',at,failedChecks:['incident_dispatch'],notice:'monitoring'};
 alertBody(event,'operator-mac');
 return {...state,lastDispatchNoticeAt:at,pending:[...state.pending,event]};
}
