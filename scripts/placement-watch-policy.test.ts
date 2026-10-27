import {expect,test} from 'vitest';
import {assessPlacement,memberRoutes,sustainedReasons} from './placement-watch-policy.mjs';
const sample=(ms=100)=>({routes:Object.fromEntries(memberRoutes.map(p=>[p,{attempts:30,errors:0,durations:Array(30).fill(ms)}])),allErrors:{requests:100,server_errors:0},operationsWarning:false});
test('operations latency/failure is warning only; sustained member regression rolls back',()=>{
 const baseline=sample(),healthy=sample();healthy.operationsWarning=true;
 expect(assessPlacement(healthy,baseline)).toEqual({reasons:[],warnings:['operations_health'],missing:[]});
 const bad=assessPlacement(sample(140),baseline);
 expect(bad.reasons).toHaveLength(4);expect(sustainedReasons(undefined,bad)).toEqual([]);expect(sustainedReasons(bad,bad)).toEqual(bad.reasons);
 expect(sustainedReasons(bad,assessPlacement(healthy,baseline))).toEqual([]);
});
test('insufficient or invalid latency is never considered healthy or used as a latency trigger',()=>{
 const baseline=sample(),s=sample();s.routes[memberRoutes[0]].durations.pop();s.routes[memberRoutes[0]].attempts=29;
 expect(assessPlacement(s,baseline).missing).toContain(memberRoutes[0]);
 expect(assessPlacement(s,baseline).reasons).toEqual([]);
 s.routes[memberRoutes[1]].durations[0]=NaN;expect(assessPlacement(s,baseline).missing).toContain(memberRoutes[1]);
});
test('errors count failed attempts, including when fewer than 30 successful timings remain',()=>{
 const baseline=sample(),s=sample();s.routes[memberRoutes[0]]={attempts:30,errors:3,durations:Array(27).fill(100)};
 s.allErrors.server_errors=3;
 const out=assessPlacement(s,baseline);expect(out.reasons).toEqual([memberRoutes[0]+':errors','aggregate_errors']);expect(out.missing).toContain(memberRoutes[0]+':latency');
});
test('uses separate route tails and a 20ms floor, without blending routes or discarding outliers',()=>{
 const baseline=sample(),s=sample(119);expect(assessPlacement(s,baseline).reasons).toEqual([]);
 s.routes[memberRoutes[1]].durations.splice(28,2,1000,1000);
 expect(assessPlacement(s,baseline).reasons).toEqual([memberRoutes[1]+':p95']);
});
