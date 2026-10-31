import {randomUUID} from 'node:crypto';
import {expect,test} from 'vitest';
import {runCommitDrillChild,validateCommitDrillPhase} from './commit-drill-runner';

const operationId=randomUUID(),generation=randomUUID(),publicationSha256='a'.repeat(64);
const phases=[{type:'phase',phase:'registered',operationId},{type:'phase',phase:'scoped',operationId,generation,scopeSha256:publicationSha256},{type:'phase',phase:'committed',operationId,sequence:'42'}];
test('only ordered phases bound to parent-owned operation and scope publication are accepted',()=>{
 for(const [stage,phase]of phases.entries())expect(validateCommitDrillPhase(phase,{stage,operationId,generation,publicationSha256})).toEqual(phase);
});
test.each([0,1,2])('duplicates, reordering and unrelated identities fail at stage %s',stage=>{
 const context={stage,operationId,generation,publicationSha256};
 for(const [other,phase]of phases.entries())if(other!==stage)expect(()=>validateCommitDrillPhase(phase,context)).toThrow();
 expect(()=>validateCommitDrillPhase({...phases[stage],operationId:randomUUID()},context)).toThrow();
 expect(()=>validateCommitDrillPhase(phases[stage],{...context,operationId:undefined})).toThrow();
 expect(()=>validateCommitDrillPhase({...phases[stage],unexpected:'private'},context)).toThrow();
});
test('child cannot supply its own generation or scope digest as independent proof',()=>{
 const context={stage:1,operationId,generation,publicationSha256};
 expect(()=>validateCommitDrillPhase({...phases[1],generation:randomUUID()},context)).toThrow();
 expect(()=>validateCommitDrillPhase({...phases[1],scopeSha256:'b'.repeat(64)},context)).toThrow();
 expect(()=>validateCommitDrillPhase(phases[1],{...context,publicationSha256:undefined})).toThrow();
});
test('zero sequence, failure messages and any post-commit phase cannot authorize a kill',()=>{
 const context={stage:2,operationId,generation,publicationSha256};
 expect(()=>validateCommitDrillPhase({...phases[2],sequence:'0'},context)).toThrow();
 expect(()=>validateCommitDrillPhase({type:'phase',phase:'failed'},context)).toThrow();
 for(const phase of phases)expect(()=>validateCommitDrillPhase(phase,{...context,stage:3})).toThrow();
});

test('a stalled initial evidence sink is bounded before any child or journal operation',async()=>{
 const records:unknown[]=[],unexpected=async()=>{throw Error('unexpected I/O');};
 await expect(runCommitDrillChild({target:'local-test',connection:'unused',fixture:{runId:randomUUID(),memberId:randomUUID(),sessionId:randomUUID()},generation,sql:{} as never,store:{get:unexpected,put:unexpected},assertScope:()=>{},retain:record=>{records.push(record);return new Promise(()=>{});}},AbortSignal.timeout(100))).rejects.toThrow('RETENTION_DEADLINE');
 expect(records).toEqual([{kind:'spawn-intent',target:'local-test'}]);
});
