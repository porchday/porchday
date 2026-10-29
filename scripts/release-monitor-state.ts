/** Read-only, public monitor evidence. Does not create observations or replay
 * ticks. Aggregate continuity is necessary but not proof of identical storage. */
export type MonitorSnapshot={environment:'staging'|'production';at:number;checkedAt:number;status:'operational'|'degraded'|'checking';metrics:'ready'|'checking'|'unavailable'|'not_configured';history:{first:number;expected:number;passed:number;failed:number;unknown:number}};
const windowMinutes=43200;
export function parseMonitorSnapshot(environment:MonitorSnapshot['environment'],responseStatus:number,body:unknown,at:number):MonitorSnapshot{
 const fail=():never=>{throw Error('MONITOR_RELEASE_STATUS_INVALID');};
 if(!['staging','production'].includes(environment)||!Number.isSafeInteger(at)||at<0||responseStatus!==200||!body||typeof body!=='object')return fail();
 const value=body as Record<string,unknown>,a=value.availability as Record<string,unknown>|undefined;
 const checkedAt=typeof value.last_checked_at==='string'?Date.parse(value.last_checked_at):NaN;
 if(!['operational','degraded','checking'].includes(value.status as string)||!['ready','checking','unavailable','not_configured'].includes(value.metrics_monitoring as string)||!Number.isSafeInteger(checkedAt)||checkedAt<at-90000||checkedAt>at+30000||!a||a.scope!=='protected_readiness_checks'||a.window_minutes!==windowMinutes)return fail();
 const first=typeof a.first_observation_at==='string'?Date.parse(a.first_observation_at):NaN;
 const expected=a.expected_minutes as number,passed=a.passed_minutes as number,failed=a.failed_minutes as number,unknown=a.unknown_minutes as number;
 if(!Number.isSafeInteger(first)||first<0||first>checkedAt||![expected,passed,failed,unknown].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=windowMinutes)||expected<1||passed+failed+unknown!==expected)return fail();
 if(a.status!==(expected===windowMinutes?'complete_window':'collecting'))return fail();
 if(a.observed_percent!==Math.round((passed+failed)/expected*100000)/1000||a.conservative_pass_percent!==Math.round(passed/expected*100000)/1000)return fail();
 return{environment,at,checkedAt,status:value.status as MonitorSnapshot['status'],metrics:value.metrics_monitoring as MonitorSnapshot['metrics'],history:{first,expected,passed,failed,unknown}};
}
export function assertMonitorContinuity(baseline:MonitorSnapshot,current:MonitorSnapshot){
 if(current.environment!==baseline.environment||current.at<baseline.at||current.checkedAt<baseline.checkedAt||current.history.first!==baseline.history.first)throw Error('MONITOR_RELEASE_HISTORY_CHANGED');
 const elapsedMinutes=Math.floor(current.at/60000)-Math.floor(baseline.at/60000);
 // Long pauses require a new review; otherwise all old samples could fall out
 // of the rolling window and this check would say nothing about preservation.
 if(elapsedMinutes>30)throw Error('MONITOR_RELEASE_BASELINE_EXPIRED');
 const expected=Math.min(windowMinutes,baseline.history.expected+elapsedMinutes),expired=Math.max(0,baseline.history.expected+elapsedMinutes-windowMinutes);
 if(current.history.expected!==expected||current.history.passed<baseline.history.passed-expired||current.history.failed<baseline.history.failed-expired)throw Error('MONITOR_RELEASE_HISTORY_CHANGED');
 if(baseline.metrics==='ready'&&current.metrics!=='ready')throw Error('MONITOR_RELEASE_METRICS_REGRESSED');
 return{elapsedMinutes,expiredMinutes:expired,scope:'public_aggregate_history' as const};
}
