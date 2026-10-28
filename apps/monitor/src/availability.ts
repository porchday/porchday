/** One bounded minute-resolution history. 0=missing, 1=passed, 2=failed.
 * No member/request data. Alert suppression never removes failed samples. */
export const WINDOW_MINUTES=30*24*60;
export type AvailabilityHistory={v:1;firstTick:number;lastTick:number;samples:string};
function valid(value:AvailabilityHistory|undefined):value is AvailabilityHistory{
 return !!value&&value.v===1&&Number.isSafeInteger(value.firstTick)&&value.firstTick>=0&&Number.isSafeInteger(value.lastTick)&&value.lastTick>=value.firstTick
  &&typeof value.samples==='string'&&/^[012]+$/.test(value.samples)&&value.samples.length===Math.min(WINDOW_MINUTES,value.lastTick-value.firstTick+1);
}
export function recordAvailability(previous:AvailabilityHistory|undefined,tick:number,healthy:boolean):AvailabilityHistory{
 if(!Number.isSafeInteger(tick)||tick<0)throw Error('AVAILABILITY_TICK_INVALID');
 if(!valid(previous))return{v:1,firstTick:tick,lastTick:tick,samples:healthy?'1':'2'};
 if(tick<=previous.lastTick)return previous;
 const gap=Math.min(WINDOW_MINUTES,tick-previous.lastTick-1);
 return{...previous,lastTick:tick,samples:(previous.samples+'0'.repeat(gap)+(healthy?'1':'2')).slice(-WINDOW_MINUTES)};
}
export function availabilitySummary(history:AvailabilityHistory|undefined,nowTick=Math.floor(Date.now()/60000)){
 if(!valid(history)||!Number.isSafeInteger(nowTick)||nowTick<history.lastTick)return{status:'unavailable' as const};
 const gap=Math.min(WINDOW_MINUTES,nowTick-history.lastTick),samples=(history.samples+'0'.repeat(gap)).slice(-WINDOW_MINUTES);
 let passed=0,failed=0;for(const s of samples){if(s==='1')passed++;if(s==='2')failed++;}
 const expected=samples.length,unknown=expected-passed-failed;
 return{status:expected===WINDOW_MINUTES?'complete_window' as const:'collecting' as const,scope:'protected_readiness_checks' as const,window_minutes:WINDOW_MINUTES,
  expected_minutes:expected,passed_minutes:passed,failed_minutes:failed,unknown_minutes:unknown,
  observed_percent:Math.round((passed+failed)/expected*100000)/1000,
  conservative_pass_percent:Math.round(passed/expected*100000)/1000,
  first_observation_at:new Date(history.firstTick*60000).toISOString()};
}
