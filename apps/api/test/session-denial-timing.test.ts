import {test,expect,vi} from 'vitest';
import {CandidateTimings} from '../src/session-denial-timing';
import {event} from '../src/telemetry';
import {sweepSessionCandidates,candidateProgressKey} from '../src/session-denial-candidates';

test('aggregates completed and failed work once per phase without exposing failures',async()=>{
 const timing=new CandidateTimings(),writeDataPoint=vi.fn();vi.useFakeTimers();
 try{
  await timing.run('sql_list',async()=>{vi.setSystemTime(Date.now()+12);return 'private-session';});
  const failure=new Error('private-token');
  await expect(timing.run('sql_list',async()=>{vi.setSystemTime(Date.now()+8);throw failure;})).rejects.toBe(failure);
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({indexes:['denial_cleanup_phase:none'],blobs:['porchday_metrics_v1','staging','denial_cleanup_phase','none','none','sql_list','none'],doubles:[0,20,2]});
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});expect(writeDataPoint).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});

test('staging-only telemetry rejects arbitrary dimensions and strips payload fields',()=>{
 const writeDataPoint=vi.fn();
 for(const ENVIRONMENT of ['production','development'] as const)event('denial_cleanup_phase',{code:'sql_list',durationMs:1,count:1},{ENVIRONMENT,METRICS:{writeDataPoint}});
 for(const fields of [{code:'private-token',durationMs:1,count:1},{code:'sql_list',durationMs:Infinity,count:1},{code:'sql_list',durationMs:1,count:-1}])event('denial_cleanup_phase',fields,{ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
 expect(writeDataPoint).not.toHaveBeenCalled();
 event('denial_cleanup_phase',{code:'sql_list',durationMs:5,count:1,route:'/health',status:500,detailMs:7,message:'private-token'} as never,{ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
 expect(writeDataPoint.mock.calls[0][0]).toEqual({indexes:['denial_cleanup_phase:none'],blobs:['porchday_metrics_v1','staging','denial_cleanup_phase','none','none','sql_list','none'],doubles:[0,5,1]});
 expect(()=>event('denial_cleanup_phase',{code:'sql_list',durationMs:1,count:1},{ENVIRONMENT:'staging',METRICS:{writeDataPoint(){throw Error('unavailable');}}})).not.toThrow();
});

test('measures concurrent authority batches as wall time and preserves sweep result',async()=>{
 const timing=new CandidateTimings(),writeDataPoint=vi.fn();let now=Date.now(),reads=0;
 const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
 try{
  const store={get:async(key:string)=>{if(key===candidateProgressKey)return null;if(reads++%5===0)now+=20;return null;},put:async()=>({etag:'confirmed'})};
  const pending=sweepSessionCandidates(store,async()=>({ids:Array.from({length:6},(_,i)=>'11111111-1111-4111-8111-'+String(i).padStart(12,'0')),more:false}),async()=>{throw Error('must not delete');},undefined,undefined,timing);
  expect(await pending).toEqual({seen:6,deleted:0,invalid:0,advanced:false});
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  const points=writeDataPoint.mock.calls.map(call=>call[0]);
  expect(points.find(point=>point.blobs[5]==='authority_batches').doubles).toEqual([0,40,2]);
  expect(points.map(point=>point.blobs[5])).toEqual(['progress_read','sql_list','authority_batches','progress_write']);
 }finally{clock.mockRestore();}
});
