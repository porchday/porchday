import {expect,it} from 'vitest';
import {advanceActionable,dispatchAttention,initialState,alertBody} from './external-monitor-alerts';
import type {Observation} from './external-monitor-probe';
const base=Date.parse('2026-11-23T00:00:00Z');
const obs=(ms:number,checks:Observation['checks']):Observation=>({v:1,at:new Date(base+ms).toISOString(),environment:'production',healthy:checks.every(c=>c.ok),checks,durationMs:1,scope:'login_authorized_reads_logout_and_readiness'});
it('keeps short transport incidents diagnostic, confirms sustained loss at two minutes',()=>{
 let s=initialState();for(let t=0;t<=120000;t+=20000){s=advanceActionable(JSON.parse(JSON.stringify(s)),obs(t,[{name:'login',ok:false,failure:'deadline'}]),'event-'+t);expect(s.pending.length).toBe(t===120000?1:0);}
 expect(s.pending[0].notice).toBe('service');
});
it('does not carry transport confirmation across gaps or recovery',()=>{
 let s=initialState();s=advanceActionable(s,obs(0,[{name:'login',ok:false,failure:'deadline'}]),'a');s=advanceActionable(s,obs(120000,[{name:'login',ok:false,failure:'deadline'}]),'b');expect(s.pending).toHaveLength(0);
 s=advanceActionable(s,obs(140000,[{name:'login',ok:true}]),'c');expect(s.pending).toHaveLength(0);
});
it('confirms HTTP failures quickly and acknowledged-logout access violations immediately',()=>{
 let s=advanceActionable(initialState(),obs(0,[{name:'login',ok:false,status:503}]),'a');s=advanceActionable(s,obs(20000,[{name:'login',ok:false,status:503}]),'b');expect(s.pending).toHaveLength(1);
 const security=advanceActionable(initialState(),obs(0,[{name:'logout',ok:true,status:200},{name:'revocation',ok:false,status:200}]),'security');expect(security.pending).toHaveLength(1);
});
it('labels sustained monitor-only faults separately and preserves legacy rendering',()=>{
 let s=initialState();for(let t=0;t<=600000;t+=20000)s=advanceActionable(s,obs(t,[{name:'login',ok:true},{name:'monitor_freshness',ok:false,failure:'deadline'}]),'event-'+t);
 expect(s.pending).toHaveLength(1);expect(s.pending[0].notice).toBe('monitoring');expect(alertBody(s.pending[0],'operator-mac')).toContain('application downtime is not established');
 const old={id:'old',kind:'outage' as const,at:new Date(base).toISOString(),failedChecks:['login']};expect(alertBody(old,'operator-mac')).toContain('External availability check failed.');expect(alertBody(old,'operator-mac')).not.toContain('Notice:');
});
it('does not emit a second downtime alert for responder failure and deduplicates standalone faults',()=>{
 let s=dispatchAttention(initialState(),new Date(base).toISOString(),'first');expect(s.pending[0].failedChecks).toEqual(['incident_dispatch']);expect(s.pending[0].notice).toBe('monitoring');
 s=dispatchAttention(s,new Date(base+1000).toISOString(),'second');expect(s.pending).toHaveLength(1);
 expect(dispatchAttention({...s,incident:true},new Date(base+7200000).toISOString(),'third').pending).toHaveLength(1);
});
