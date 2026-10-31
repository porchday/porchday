import {expect,it} from 'vitest';
import {startTrial,advanceTrial,validateTrialHistory} from './placement-trial.mjs';
const minute=60000,start=1800000000000,id='12345678-1234-1234-1234-123456789abc';
const metrics=(ms=100)=>({routes:Object.fromEntries(['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10'].map(p=>[p,{attempts:30,errors:0,durations:Array(30).fill(ms)}])),allErrors:{requests:60,server_errors:0},operationsWarning:false});
const baseline=()=>({connections:Array.from({length:6},(_,i)=>({at:start-(5-i)*minute,total:10,usable:22,refused:false})),windows:[{...metrics(),startedAt:start-10*minute,endedAt:start-7*minute},{...metrics(),startedAt:start-6*minute,endedAt:start-minute}],auth:true,revocation:true,privacy:true,readiness:true,publicAssets:true});
const sample=(n:number)=>({at:start+n*minute,auth:true,revocation:true,privacy:true,readiness:true,publicAssets:true,refused:false,connection:{total:10,usable:22,refused:false},window:n%5===0?{...metrics(),startedAt:start+(n-5)*minute,endedAt:start+n*minute}:null});
it('requires a full hour, 60 snapshots and 12 windows; validates the durable history',()=>{
 const b=baseline(),records=[startTrial(id,start,b)];
 for(let n=1;n<=60;n++){
  records.push(advanceTrial(records.at(-1),sample(n),b));
  expect(records.at(-1).status).toBe(n===60?'retain':'watching');
 }
 expect(validateTrialHistory(JSON.parse(JSON.stringify(records)),b)).toEqual(records.at(-1));
 const tampered=structuredClone(records);tampered[30].connectionSamples=60;
 expect(()=>validateTrialHistory(tampered,b)).toThrow('TRIAL_HISTORY_CHANGED');
});
it.each(['auth','revocation','privacy','publicAssets','refused'])('immediately stops on %s failure',name=>{
 const b=baseline(),s=sample(1);s[name]=name==='refused';
 const stopped=advanceTrial(startTrial(id,start,b),s,b);
 expect(stopped.status).toBe('rollback-required');
 expect(()=>advanceTrial(stopped,sample(2),b)).toThrow('TRIAL_STATE_OR_BASELINE_CHANGED');
});
it('requires sustained readiness and high-connection failures, but stops immediately at exhaustion',()=>{
 const b=baseline();let state=startTrial(id,start,b);
 const first=sample(1);first.connection.total=18;first.readiness=false;
 state=advanceTrial(state,first,b);expect(state.status).toBe('watching');
 const second=sample(2);second.connection.total=18;second.readiness=false;
 state=advanceTrial(state,second,b);expect(state.reasons).toEqual(['sustained_readiness','sustained_connection_headroom']);
 const exhausted=sample(1);exhausted.connection.total=22;
 expect(advanceTrial(startTrial(id,start,b),exhausted,b).reasons).toContain('usable_slots_exhausted');
});
it('cannot resume across a two-minute observation gap or conceal missing connections',()=>{
 const b=baseline(),initial=startTrial(id,start,b);
 expect(advanceTrial(initial,sample(2),b).reasons).toContain('observation_gap');
 const missing=sample(1);missing.connection=null;
 const next=advanceTrial(initial,missing,b);expect(next.status).toBe('watching');
 const missingAgain=sample(2);missingAgain.connection=null;
 expect(advanceTrial(next,missingAgain,b).reasons).toContain('connection_coverage_gap');
});
it('stops after two consecutive route regressions and does not stop on operations warnings',()=>{
 const b=baseline();let state=startTrial(id,start,b);
 for(let n=1;n<=10;n++){
  const s=sample(n);
  if(s.window){s.window={...s.window,...metrics(140)};s.window.operationsWarning=true;}
  state=advanceTrial(state,s,b);
  expect(state.status).toBe(n===10?'rollback-required':'watching');
 }
 expect(state.reasons).toHaveLength(4);expect(state.reasons).not.toContain('operations_health');
});
it('rejects stale, thin, or pressured baselines before activation',()=>{
 const b=baseline();b.connections[5].total=18;
 expect(()=>startTrial(id,start,b)).toThrow('TRIAL_BASELINE_HEADROOM_UNSUITABLE');
 const stale=baseline();expect(()=>startTrial(id,start+3*minute,stale)).toThrow('TRIAL_BASELINE_STALE');
 const thin=baseline();thin.windows[0].routes['/api/v1/feed?limit=10'].attempts=29;
 expect(()=>startTrial(id,start,thin)).toThrow('TRIAL_BASELINE_WINDOWS_INCOMPLETE');
});
