import {expect,test} from 'vitest';
import {CandidateCapacityProof,exactCandidateProgress,type ExactCandidateProgress} from './session-denial-capacity-proof';

const baseline=()=>progress(1_000_000,1000,3);
function progress(completedAt:number,durationMs:number,seen=10003):ExactCandidateProgress{
 return {pageCompletedAt:completedAt,passStartedAt:null,passSeen:0,passInvalid:0,lastPass:{completedAt,durationMs,seen,invalid:0}};
}
const proof=()=>new CandidateCapacityProof(1_002_000,10000,baseline(),1_001_000);

test('accepts two intact-fixture full passes and returns defensive exact evidence',()=>{
 const p=proof(),first=progress(1_200_000,190000),second=progress(1_459_000,200000);
 p.observe(first,1_201_000);first.lastPass!.seen=1;
 p.observe(second,1_460_000);second.lastPass!.durationMs=1;
 const result=p.finish();expect(result.completedPasses.map(x=>x.durationMs)).toEqual([190000,200000]);
 expect(result.fullPassIntervalsMs).toEqual([200000,259000]);expect(result.maxFullPassIntervalMs).toBe(259000);
 result.completedPasses[0].seen=0;expect(p.finish().completedPasses[0].seen).toBe(10003);
});

test('rejects the missed-between-probes stale interval even when both current ages are healthy',()=>{
 const p=proof();p.observe(progress(1_200_000,190000),1_201_000);
 expect(()=>p.observe(progress(1_502_518,259000),1_503_518)).toThrow('CAPACITY_FULL_PASS_INTERVAL_EXCEEDED');
 // A caller cannot ignore the failed observation and later claim acceptance.
 expect(()=>p.observe(progress(1_600_000,90000),1_601_000)).toThrow('CAPACITY_PROOF_FAILED');
 expect(()=>p.finish()).toThrow('CAPACITY_PROOF_FAILED');
});

test('enforces the exact threshold without rounding it down to sampled seconds',()=>{
 const allowed=proof();allowed.observe(progress(1_200_000,190000),1_201_000);
 allowed.observe(progress(1_500_000,250000),1_501_000);expect(allowed.finish().maxFullPassIntervalMs).toBe(300000);
 const rejected=proof();rejected.observe(progress(1_200_000,190000),1_201_000);
 expect(()=>rejected.observe(progress(1_500_001,250000),1_501_001)).toThrow('CAPACITY_FULL_PASS_INTERVAL_EXCEEDED');
});

test('repeated reads and passes begun before fixture commit cannot satisfy two-pass acceptance',()=>{
 const p=proof();const partial=progress(1_050_000,49000);
 p.observe(partial,1_051_000);p.observe(partial,1_052_000);
 p.observe(progress(1_200_000,140000,9999),1_201_000);
 p.observe(progress(1_400_000,190000),1_401_000);
 expect(()=>p.finish()).toThrow('CAPACITY_TWO_FULL_PASSES_REQUIRED');
});

test('rejects unknown, unhealthy, regressed and mutated completion evidence',()=>{
 expect(()=>new CandidateCapacityProof(1_002_000,10000,{...baseline(),lastPass:null},1_001_000)).toThrow();
 for(const mutate of [
  (x:ExactCandidateProgress)=>{x.pageCompletedAt=2_000_000;},
  (x:ExactCandidateProgress)=>{x.lastPass!.invalid=1;},
  (x:ExactCandidateProgress)=>{x.lastPass!.durationMs=300001;},
 ]){const p=proof(),x=progress(1_200_000,190000);mutate(x);expect(()=>p.observe(x,1_201_000)).toThrow();expect(()=>p.finish()).toThrow('CAPACITY_PROOF_FAILED');}
 const p=proof();p.observe(progress(1_200_000,190000),1_201_000);
 expect(()=>p.observe(progress(1_200_000,189999),1_202_000)).toThrow('CAPACITY_PASS_CHANGED');
 const q=proof();q.observe(progress(1_200_000,190000),1_201_000);
 expect(()=>q.observe(baseline(),1_202_000)).toThrow();
});

test('parses strict persisted v3 progress while excluding cursor identifiers',()=>{
 const raw={v:3,strategy:'sql-session-keyset',cursor:'private-session-id',pageCompletedAt:1_050_000,passStartedAt:1_010_000,passSeen:100,passInvalid:0,lastPass:baseline().lastPass};
 const observed=exactCandidateProgress(JSON.stringify(raw));expect(observed.passSeen).toBe(100);
 expect(JSON.stringify(observed)).not.toContain('private-session-id');expect(observed).not.toHaveProperty('cursor');
 for(const bad of [{...raw,v:2},{...raw,strategy:'other'},{...raw,unexpected:'private'},{...raw,passInvalid:101}])expect(()=>exactCandidateProgress(JSON.stringify(bad))).toThrow();
 expect(()=>exactCandidateProgress(' '.repeat(16385))).toThrow();
});
