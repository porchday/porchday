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
  const store={get:async(key:string)=>{if(key===candidateProgressKey)return null;if(reads++%6===0)now+=20;return null;},put:async()=>({etag:'confirmed'})};
  const pending=sweepSessionCandidates(store,async()=>({ids:Array.from({length:7},(_,i)=>'11111111-1111-4111-8111-'+String(i).padStart(12,'0')),more:false}),async()=>{throw Error('must not delete');},undefined,undefined,timing);
  expect(await pending).toEqual({seen:7,deleted:0,invalid:0,advanced:false});
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  const points=writeDataPoint.mock.calls.map(call=>call[0]);
  expect(points.find(point=>point.blobs[5]==='authority_batches').doubles).toEqual([0,40,2]);
  expect(points.filter(point=>point.blobs[2]==='denial_cleanup_phase').map(point=>point.blobs[5])).toEqual(['progress_read','sql_list','authority_batches','progress_write']);
  expect(points.filter(point=>point.blobs[2]==='denial_cleanup_authority')).toHaveLength(1);
 }finally{clock.mockRestore();}
});

test('pairs slot capacity and occupied time for unequal and partial successful batches',async()=>{
 vi.useFakeTimers();
 try{
  const timing=new CandidateTimings(),writeDataPoint=vi.fn();
  const work=(ms:number,value:string)=>()=>new Promise<string>(resolve=>setTimeout(()=>resolve(value),ms));
  const first=timing.authorityBatch([work(10,'fast'),work(60,'slow')]);
  await vi.advanceTimersByTimeAsync(60);expect(await first).toEqual(['fast','slow']);
  const partial=timing.authorityBatch([work(20,'partial')]);
  await vi.advanceTimersByTimeAsync(20);expect(await partial).toEqual(['partial']);
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  const point=writeDataPoint.mock.calls.map(call=>call[0]).find(point=>point.blobs[2]==='denial_cleanup_authority');
  expect(point).toEqual({indexes:['denial_cleanup_authority:none'],blobs:['porchday_metrics_v1','staging','denial_cleanup_authority','none','none','none','none'],doubles:[0,140,3,90]});
  const count=writeDataPoint.mock.calls.length;timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});expect(writeDataPoint).toHaveBeenCalledTimes(count);
 }finally{vi.useRealTimers();}
});

test('failed batches retain phase timing but late reads cannot publish occupancy',async()=>{
 vi.useFakeTimers();
 try{
  const timing=new CandidateTimings(),writeDataPoint=vi.fn();
  const failure=new Error('private-failure');
  const pending=timing.authorityBatch([
   ()=>new Promise((_,reject)=>setTimeout(()=>reject(failure),10)),
   ()=>new Promise(resolve=>setTimeout(()=>resolve('private-session'),100)),
  ]);
  const rejected=expect(pending).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(10);await rejected;
  timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  await vi.advanceTimersByTimeAsync(100);timing.flush({ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(writeDataPoint.mock.calls[0][0].blobs[5]).toBe('authority_batches');
  expect(writeDataPoint.mock.calls[0][0].doubles).toEqual([0,10,1]);
 }finally{vi.useRealTimers();}
});

test('authority occupancy telemetry is staging-only, bounded and strips dimensions',()=>{
 const writeDataPoint=vi.fn(),valid={durationMs:120,detailMs:70,count:2};
 for(const ENVIRONMENT of ['production','development'] as const)event('denial_cleanup_authority',valid,{ENVIRONMENT,METRICS:{writeDataPoint}});
 for(const fields of [{...valid,detailMs:121},{...valid,durationMs:Infinity},{...valid,detailMs:NaN},{...valid,count:0},{...valid,count:1.5},{...valid,detailMs:-1}])event('denial_cleanup_authority',fields,{ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
 expect(writeDataPoint).not.toHaveBeenCalled();
 event('denial_cleanup_authority',{...valid,route:'/health',code:'private-session',status:500,message:'private-token'} as never,{ENVIRONMENT:'staging',METRICS:{writeDataPoint}});
 expect(writeDataPoint.mock.calls[0][0]).toEqual({indexes:['denial_cleanup_authority:none'],blobs:['porchday_metrics_v1','staging','denial_cleanup_authority','none','none','none','none'],doubles:[0,120,2,70]});
 expect(()=>event('denial_cleanup_authority',valid,{ENVIRONMENT:'staging',METRICS:{writeDataPoint(){throw Error('failure');}}})).not.toThrow();
});
