import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FilePlacementTrialJournal} from './placement-trial-journal.mjs';
const t=1800000000000,minute=60000;
const metrics={routes:Object.fromEntries(['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10'].map(p=>[p,{attempts:30,errors:0,durations:Array(30).fill(100)}])),allErrors:{requests:60,server_errors:0}};
const baseline={connections:Array.from({length:6},(_,i)=>({at:t-(5-i)*minute,total:10,usable:22,refused:false})),windows:[{...metrics,startedAt:t-10*minute,endedAt:t-7*minute},{...metrics,startedAt:t-6*minute,endedAt:t-minute}],auth:true,revocation:true,privacy:true,readiness:true,publicAssets:true};
function setup(){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'placement-trial-')));chmodSync(directory,0o700);
 const options={directory,operationId:'12345678-1234-1234-1234-123456789abc',startedAt:t,baseline,assertLease:()=>{}};
 return{directory,options,journal:new FilePlacementTrialJournal(options)};
}
it('resumes decisions, rejects replay and stale CAS, and keeps terminal stops',()=>{
 const {directory,options,journal}=setup();
 try{
  const initial=journal.start();
  expect(()=>journal.start()).toThrow('TRIAL_ALREADY_STARTED');
  const sample={at:t+minute,auth:false,revocation:true,privacy:true,readiness:true,publicAssets:true,refused:false,connection:{total:10,usable:22,refused:false},window:null};
  const stopped=journal.sample(initial,sample);
  expect(stopped.status).toBe('rollback-required');
  expect(new FilePlacementTrialJournal(options).read()).toEqual(stopped);
  expect(()=>journal.sample(initial,sample)).toThrow('TRIAL_JOURNAL_CONFLICT');
  expect(()=>journal.sample(stopped,{...sample,at:t+2*minute})).toThrow('TRIAL_STATE_OR_BASELINE_CHANGED');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('fails closed on a partial durable record and changed operation scope',()=>{
 const {directory,options,journal}=setup();
 try{
  journal.start();
  expect(()=>new FilePlacementTrialJournal({...options,operationId:'22345678-1234-1234-1234-123456789abc'}).read()).toThrow('TRIAL_JOURNAL_SCOPE_CHANGED');
  writeFileSync(join(directory,'00002.json'),'{',{mode:0o600});
  expect(()=>journal.read()).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('requires the live lease for reads and appends',()=>{
 const {directory,options,journal}=setup();
 try{
  const initial=journal.start();let owned=true;
  const guarded=new FilePlacementTrialJournal({...options,assertLease:()=>{if(!owned)throw Error('LEASE_LOST');}});
  owned=false;
  expect(()=>guarded.read()).toThrow('LEASE_LOST');
  expect(()=>guarded.append(null,initial)).toThrow('LEASE_LOST');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
