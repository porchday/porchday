import {describe,it,expect,vi} from 'vitest';
import {observeDenialPartitions,allDenialPassesStartedAfter,captureDenialCapacitySample} from './denial-capacity-observation';
import {denialPartitions,type PartitionProgress} from '../apps/api/src/session-denial-partitions';
function progress(partition:0|1|2,at=1000000):PartitionProgress{return {v:4,strategy:'sql-session-ranges',partition,cursor:null,pageCompletedAt:at,passStartedAt:null,passSeen:0,passInvalid:0,lastPass:{completedAt:at,durationMs:1000,seen:100,invalid:0}};}
function store(rows:(PartitionProgress|null|Error)[]){return {get:vi.fn(async(key:string)=>{const row=rows[Number(key.match(/range-(\d)/)![1])];if(row instanceof Error)throw row;return row?{text:async()=>JSON.stringify(row)}:null;})};}
describe('capacity evidence survives failed acceptance',()=>{
 it('persists the actual stale cycle with its counts and journey before assertion',async()=>{
  const f=store([progress(0,694000),progress(1),progress(2)]),persist=vi.fn();
  const sample=await captureDenialCapacitySample({journey:async()=>({healthy:true}),count:async()=>({live:10000,denied:184}),progress:()=>observeDenialPartitions(f,1000000)},persist);
  expect(persist).toHaveBeenCalledExactlyOnceWith(sample);
  expect(sample.observations.count).toMatchObject({ok:true,value:{live:10000,denied:184}});
  expect(sample.observations.progress).toMatchObject({ok:true,value:{health:{issues:expect.arrayContaining(['session_denial_pass_stale']),snapshot:{pass_age_seconds:306}}}});
  expect(f.get).toHaveBeenCalledTimes(3);
 });
 it.each([null,new Error('private connection string')])('retains other ranges when one cannot be read',async bad=>{
  const result=await observeDenialPartitions(store([progress(0),bad,progress(2)]),1000000);
  expect(result.ranges[0].progress).toEqual(progress(0));expect(result.ranges[2].progress).toEqual(progress(2));
  expect(result.health.issues).toContain('session_denial_cleanup_missing');expect(JSON.stringify(result)).not.toContain('private');
  expect(allDenialPassesStartedAfter(result.ranges.map(x=>x.progress),1)).toBe(false);
 });
 it('retains invalid-time evidence while refusing to call it healthy',async()=>{
  const result=await observeDenialPartitions(store([progress(0,1000001),progress(1),progress(2)]),1000000);
  expect(result.ranges[0].progress?.pageCompletedAt).toBe(1000001);
  expect(result.health).toEqual({issues:['session_denial_cleanup_unavailable'],snapshot:null});
 });
 it('does not treat missing, unordered or pre-barrier passes as recovered',()=>{
  const values=denialPartitions.map(p=>progress(p));
  expect(allDenialPassesStartedAfter(values,999000)).toBe(true);
  expect(allDenialPassesStartedAfter(values,999001)).toBe(false);
  expect(allDenialPassesStartedAfter([values[1],values[0],values[2]],1)).toBe(false);
  expect(allDenialPassesStartedAfter(values.slice(1),1)).toBe(false);
  expect(allDenialPassesStartedAfter(values,NaN)).toBe(false);
 });
 it('records failed reads, continues remaining observations once and redacts exceptions',async()=>{
  const order:string[]=[],journey=vi.fn(async()=>{order.push('journey');throw Error('secret');}),count=vi.fn(async()=>{order.push('count');return {live:10000};}),persist=vi.fn(async()=>{order.push('persist');});
  const result=await captureDenialCapacitySample({journey,count},persist);
  expect(order).toEqual(['journey','count','persist']);expect(journey).toHaveBeenCalledTimes(1);expect(count).toHaveBeenCalledTimes(1);
  expect(result.observations.journey).toMatchObject({ok:false,error:'observation_failed'});expect(result.observations.count).toMatchObject({ok:true,value:{live:10000}});expect(JSON.stringify(result)).not.toContain('secret');
 });
 it('propagates failed persistence without retrying any operation or save',async()=>{
  const read=vi.fn(async()=>1),persist=vi.fn(()=>{throw Error('DISK_FULL');});
  await expect(captureDenialCapacitySample({read},persist)).rejects.toThrow('DISK_FULL');
  expect(read).toHaveBeenCalledTimes(1);expect(persist).toHaveBeenCalledTimes(1);
 });
});
