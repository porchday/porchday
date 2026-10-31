import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,realpathSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPlacementTrial} from './placement-trial-runner.mjs';
import {FilePlacementTrialJournal} from './placement-trial-journal.mjs';
const t=1800000000000,minute=60000,id='12345678-1234-1234-1234-123456789abc';
const metrics={routes:Object.fromEntries(['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10'].map(p=>[p,{attempts:30,errors:0,durations:Array(30).fill(100)}])),allErrors:{requests:60,server_errors:0}};
const baseline={connections:Array.from({length:6},(_,i)=>({at:t-(5-i)*minute,total:10,usable:22,refused:false})),windows:[{...metrics,startedAt:t-10*minute,endedAt:t-7*minute},{...metrics,startedAt:t-6*minute,endedAt:t-minute}],auth:true,revocation:true,privacy:true,readiness:true,publicAssets:true};
const sample=({at,lastWindowAt}:{at:number;lastWindowAt:number})=>({auth:true,revocation:true,privacy:true,readiness:true,publicAssets:true,refused:false,connection:{total:10,usable:22,refused:false},window:at-lastWindowAt>=5*minute?{...metrics,startedAt:lastWindowAt,endedAt:at}:null});
afterEach(()=>vi.useRealTimers());
it('holds the complete hour and persists all observations before retention',async()=>{
 vi.useFakeTimers();vi.setSystemTime(t);
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'trial-runner-'))),collect=vi.fn(async input=>sample(input)),assertInventory=vi.fn(async()=>{});
 try{
  const result=runPlacementTrial({directory,operationId:id,baseline,collect,assertInventory,assertLease:()=>{},signal:new AbortController().signal});
  await vi.advanceTimersByTimeAsync(60*minute);
  expect(await result).toBe('healthy');expect(collect).toHaveBeenCalledTimes(60);
  expect(readdirSync(directory)).toHaveLength(61);
  const final=JSON.parse(readFileSync(join(directory,'00061.json'),'utf8'));
  expect(final.status).toBe('retain');expect(final.at-final.startedAt).toBe(60*minute);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('persists a stop on resumed coverage loss without another external sample',async()=>{
 vi.useFakeTimers();vi.setSystemTime(t+3*minute);
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'trial-runner-'))),collect=vi.fn(async input=>sample(input));
 try{
  new FilePlacementTrialJournal({directory,operationId:id,startedAt:t,baseline,assertLease:()=>{}}).start();
  const result=runPlacementTrial({directory,operationId:id,baseline,collect,assertInventory:async()=>{},assertLease:()=>{},signal:new AbortController().signal});
  await vi.advanceTimersByTimeAsync(1);expect(await result).toBe('unhealthy');expect(collect).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(directory,'00002.json'),'utf8')).reasons).toContain('observation_gap');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('bounds a failed collector and records a rollback decision instead of retrying',async()=>{
 vi.useFakeTimers();vi.setSystemTime(t);
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'trial-runner-'))),collect=vi.fn(()=>new Promise(()=>{}));
 try{
  const result=runPlacementTrial({directory,operationId:id,baseline,collect,assertInventory:async()=>{},assertLease:()=>{},signal:new AbortController().signal});
  await vi.advanceTimersByTimeAsync(minute+45000);expect(await result).toBe('unhealthy');expect(collect).toHaveBeenCalledTimes(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
