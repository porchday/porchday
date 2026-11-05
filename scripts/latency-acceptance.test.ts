import {expect,test} from 'vitest';
import {assessLatency} from './latency-acceptance.mjs';
const run=(changes:Record<string,unknown>={})=>({id:'baseline',environment:'staging',release:'a'.repeat(40),region:'us-west',regionEvidence:'operator-attested',platform:'pwa',device:'physical-phone',network:'cellular',workload:'small-wall',operation:'feed',scenario:'feed-first-page',scope:'end-to-end',startedAt:'2026-10-28T01:00:00Z',endedAt:'2026-10-28T02:00:00Z',expectedAttempts:10000,samples:Array.from({length:10000},(_,ordinal)=>({ordinal,elapsedMs:300,outcome:'success'})),...changes});
const report=(r=run())=>assessLatency({version:1,runs:[r]}).reports[0];
test('does not turn a small sample into a passing percentile',()=>{
 const r=report(run({expectedAttempts:20,samples:run().samples.slice(0,20)}));
 expect(r.verdict).toBe('insufficient-evidence');expect(r.p99Ms).toBeNull();
});
test('nearest-rank boundary includes slow attempts rather than interpolation',()=>{
 const r=run();r.samples[9899].elapsedMs=1001;
 for(let n=9900;n<10000;n++)r.samples[n].elapsedMs=2000;
 expect(report(r)).toMatchObject({p50Ms:300,p95Ms:300,p99Ms:1001,verdict:'above-target'});
});
test.each(['timeout','error'])('does not hide fast %s outcomes',outcome=>{
 const r=run();for(let n=0;n<101;n++)r.samples[n]={ordinal:n,elapsedMs:1,outcome};
 expect(report(r)).toMatchObject({p99Ms:'unbounded',verdict:'above-target',failureRate:.0101});
});
test('incomplete runs cannot pass even with ten thousand recorded attempts',()=>{
 expect(report(run({expectedAttempts:10001}))).toMatchObject({missingAttempts:1,verdict:'insufficient-evidence'});
});
test('rejects duplicates, invalid durations, unknown fields and misleading logout server timing',()=>{
 const r=run();r.samples[1].ordinal=0;expect(()=>report(r)).toThrow();
 for(const elapsedMs of [-1,NaN,Infinity])expect(()=>report(run({samples:[{ordinal:0,outcome:'success',elapsedMs}]}))).toThrow();
 expect(()=>report(run({cookie:'secret'}))).toThrow();
 expect(()=>report(run({operation:'logout',scope:'server'}))).toThrow();
});
test('keeps regions and releases distinct and never certifies overall acceptance',()=>{
 const r=assessLatency({version:1,runs:[run(),run({id:'manila',region:'manila',release:'b'.repeat(40)})]});
 expect(r.reports).toHaveLength(2);expect(r.reports[0].verdict).toBe('within-target');
 expect(r.reports[0].reliabilityAcceptance).toBe('not-assessed');expect(r.releaseAcceptance).toBe('not-assessed');
});
test('requires geographic evidence and actual phone/network evidence for client claims',()=>{
 expect(report(run({regionEvidence:'unknown'})).verdict).toBe('insufficient-evidence');
 expect(report(run({device:'simulator',network:'emulated'})).verdict).toBe('insufficient-evidence');
});
