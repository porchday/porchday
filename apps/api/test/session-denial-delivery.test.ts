import {describe,it,expect,vi} from 'vitest';
import type {Env} from '../src/types';
import {isolatedDenialDelivery,denialDeliveryAction,denialDeliveryQueue} from '../src/session-denial-delivery';
import {scheduleDenialCleanup,enqueuePartitionContinuation,readManagedDenialCleanupHealth} from '../src/session-denial-runtime';
function env(){return {ENVIRONMENT:'staging',SESSION_DENIAL_CLEANUP_V1:'true',SESSION_DENIAL_PARTITIONS_V1:'active',SESSION_DENIAL_QUEUE_TOPOLOGY_V1:'isolated',JOBS:{send:vi.fn(async()=>{})},DENIAL_RANGE_0:{send:vi.fn(async()=>{})},DENIAL_RANGE_1:{send:vi.fn(async()=>{})},DENIAL_RANGE_2:{send:vi.fn(async()=>{})}} as unknown as Env;}
describe('fixed isolated denial delivery',()=>{
 it('sends each range and its continuation only to its assigned queue',async()=>{
  const e=env();await scheduleDenialCleanup(e);await enqueuePartitionContinuation(e,1,'v4:1:etag');
  expect(e.JOBS.send).not.toHaveBeenCalled();
  expect(e.DENIAL_RANGE_0!.send).toHaveBeenCalledExactlyOnceWith({kind:'session_denial_cleanup_partition',denialPartition:0});
  expect(e.DENIAL_RANGE_1!.send).toHaveBeenCalledTimes(2);expect(e.DENIAL_RANGE_1!.send).toHaveBeenLastCalledWith({kind:'session_denial_cleanup_partition',denialPartition:1,denialProgressEtag:'v4:1:etag'});
  expect(e.DENIAL_RANGE_2!.send).toHaveBeenCalledTimes(1);
 });
 it('keeps legacy scheduling on the ordinary queue in dual mode',async()=>{
  const e=env();e.SESSION_DENIAL_PARTITIONS_V1='dual';await scheduleDenialCleanup(e);expect(e.JOBS.send).toHaveBeenCalledExactlyOnceWith({kind:'session_denial_cleanup'});
 });
 it('rejects incomplete admission before sending any range',async()=>{
  const e=env();delete e.DENIAL_RANGE_2;await expect(scheduleDenialCleanup(e)).rejects.toThrow();
  expect(e.JOBS.send).not.toHaveBeenCalled();expect(e.DENIAL_RANGE_0!.send).not.toHaveBeenCalled();expect(e.DENIAL_RANGE_1!.send).not.toHaveBeenCalled();
  expect((await readManagedDenialCleanupHealth(e)).issues).toContain('session_denial_cleanup_unavailable');
 });
 it.each(['', 'true','ISOLATED'])('rejects invalid topology %s',value=>{const e=env();e.SESSION_DENIAL_QUEUE_TOPOLOGY_V1=value;expect(()=>isolatedDenialDelivery(e)).toThrow();});
 it('requires cleanup, range mode and a known environment',()=>{
  for(const change of [{SESSION_DENIAL_CLEANUP_V1:undefined},{SESSION_DENIAL_PARTITIONS_V1:'disabled'},{ENVIRONMENT:'other'}])expect(()=>isolatedDenialDelivery({...env(),...change} as Env)).toThrow();
 });
 it('rejects cross-range and unrelated payloads before dispatch',()=>{
  const e=env();for(const job of [{kind:'expiry'},{kind:'session_denial_cleanup'},{kind:'session_denial_cleanup_partition',denialPartition:2}] as const)expect(()=>denialDeliveryAction(e,'porchday-staging-denial-1',job)).toThrow();
  expect(()=>denialDeliveryAction(e,'porchday-production-denial-1',{kind:'session_denial_cleanup_partition',denialPartition:1})).toThrow();
  expect(()=>denialDeliveryQueue(e,{kind:'session_denial_cleanup_partition',denialPartition:99})).toThrow();
 });
 it('drains old topology deliveries without replay and preserves ordinary work',()=>{
  const e=env(),job={kind:'session_denial_cleanup_partition' as const,denialPartition:1};
  expect(denialDeliveryAction(e,'porchday-staging-jobs',job)).toBe('obsolete');expect(denialDeliveryAction(e,'porchday-staging-denial-1',job)).toBe('process');
  expect(denialDeliveryAction(e,'porchday-staging-jobs',{kind:'expiry'})).toBe('process');
  delete e.SESSION_DENIAL_QUEUE_TOPOLOGY_V1;
  expect(denialDeliveryAction(e,'porchday-staging-denial-1',job)).toBe('obsolete');expect(denialDeliveryAction(e,'porchday-staging-jobs',job)).toBe('process');expect(denialDeliveryQueue(e,job)).toBe(e.JOBS);
 });
 it('settles failed sends without falling back to the shared queue',async()=>{
  const e=env();vi.mocked(e.DENIAL_RANGE_0!.send).mockRejectedValue(Error('lost reply'));await expect(scheduleDenialCleanup(e)).rejects.toThrow();
  expect(e.DENIAL_RANGE_0!.send).toHaveBeenCalledTimes(1);expect(e.DENIAL_RANGE_1!.send).toHaveBeenCalledTimes(1);expect(e.DENIAL_RANGE_2!.send).toHaveBeenCalledTimes(1);expect(e.JOBS.send).not.toHaveBeenCalled();
 });
});
