import {expect,it} from 'vitest';
import {parseMonitorSnapshot,assertMonitorContinuity,assertMonitorRecoveryContinuity} from './release-monitor-state';
const at=Date.UTC(2026,9,29,14,0),first=at-9*60000;
const body=()=>({status:'operational',last_checked_at:new Date(at).toISOString(),metrics_monitoring:'ready',availability:{status:'collecting',scope:'protected_readiness_checks',window_minutes:43200,first_observation_at:new Date(first).toISOString(),expected_minutes:10,passed_minutes:7,failed_minutes:2,unknown_minutes:1,observed_percent:90,conservative_pass_percent:70}});
const base=()=>parseMonitorSnapshot('staging',200,body(),at);
it('accepts preserved history and additional scheduled evidence',()=>{const before=base(),after={...before,at:at+60000,checkedAt:at+60000,history:{...before.history,expected:11,passed:8}};expect(assertMonitorContinuity(before,after)).toEqual({elapsedMinutes:1,expiredMinutes:0,scope:'public_aggregate_history'});});
it.each(['status','stale','future','counts','percent','scope'] as const)('rejects malformed or unhealthy status evidence: %s',kind=>{const b=body();if(kind==='status')b.status='unknown';if(kind==='stale')b.last_checked_at=new Date(at-90001).toISOString();if(kind==='future')b.last_checked_at=new Date(at+30001).toISOString();if(kind==='counts')b.availability.failed_minutes=1;if(kind==='percent')b.availability.observed_percent=100;if(kind==='scope')b.availability.scope='other';expect(()=>parseMonitorSnapshot('staging',200,b,at)).toThrow('STATUS_INVALID');});
it.each(['environment','origin','lost-pass','lost-failure','metrics','clock','expired'] as const)('rejects continuity regression: %s',kind=>{const before=base(),after=structuredClone(before);if(kind==='environment')after.environment='production';if(kind==='origin')after.history.first++;if(kind==='lost-pass')after.history.passed--;if(kind==='lost-failure')after.history.failed--;if(kind==='metrics')after.metrics='unavailable';if(kind==='clock')after.checkedAt--;if(kind==='expired')after.at+=31*60000;expect(()=>assertMonitorContinuity(before,after)).toThrow();});
it('allows only the minute samples that actually roll out of a full window',()=>{const before=base();before.history={first:at-50000*60000,expected:43200,passed:43000,failed:100,unknown:100};const after={...before,at:at+60000,checkedAt:at+60000,history:{...before.history,passed:42999,unknown:101}};expect(assertMonitorContinuity(before,after).expiredMinutes).toBe(1);after.history.failed-=2;expect(()=>assertMonitorContinuity(before,after)).toThrow('HISTORY_CHANGED');});
it('cannot interpret HTTP503 as valid status evidence',()=>{expect(()=>parseMonitorSnapshot('production',503,body(),at)).toThrow('STATUS_INVALID');});

it('incident recovery preserves all observations and rejects expired evidence or a rolled window',()=>{
 const before=base(),after={...before,at:at+120*60000,checkedAt:at+120*60000,history:{...before.history,expected:130,unknown:121}};
 expect(assertMonitorRecoveryContinuity(before,after)).toMatchObject({elapsedMinutes:120,expiredMinutes:0});
 expect(()=>assertMonitorContinuity(before,after)).toThrow('BASELINE_EXPIRED');
 expect(()=>assertMonitorRecoveryContinuity(before,{...after,at:at+361*60000})).toThrow('BASELINE_EXPIRED');
 before.history.expected=43200;expect(()=>assertMonitorRecoveryContinuity(before,after)).toThrow('HISTORY_EXPIRED');
});
