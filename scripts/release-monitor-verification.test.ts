import {waitForMonitorRecovery} from './release-monitor-recovery-wait';
import {expect,it,vi} from 'vitest';
import {realpathSync,mkdtempSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';
import{verifyMonitorRead}from'./release-monitor-verification';import{readMonitorReview,type ActivationReviewEvidence}from'./release-activation-review';import type{DeploymentPlan}from'./deployment-recovery';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
function fixture(){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'monitor-verifier-'))),now=Math.floor(Date.now()/60000)*60000;
 const body={status:'operational',last_checked_at:new Date(now).toISOString(),metrics_monitoring:'ready',availability:{status:'collecting',scope:'protected_readiness_checks',window_minutes:43200,first_observation_at:new Date(now-9*60000).toISOString(),expected_minutes:10,passed_minutes:7,failed_minutes:2,unknown_minutes:1,observed_percent:90,conservative_pass_percent:70}};
 const file=(name:string,value:unknown)=>{const bytes=JSON.stringify(value),path=join(directory,name);writeFileSync(path,bytes,{mode:0o600});return{path,sha256:createHash('sha256').update(bytes).digest('hex')};};
 const baseline=file('baseline.json',{environment:'staging',at:now,status:200,body}),proof=file('overlap.json',{passed:true});
 const storageCompatibility=file('compatibility.json',{version:1,baselineSource:'c'.repeat(40),candidateSource:'a'.repeat(40),compatible:true,evidence:[proof]});
 const review={state:{baseline:{source:'c'.repeat(40)}},monitor:{baseline,storageCompatibility}} as ActivationReviewEvidence;
 const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-monitor-staging',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64)};
 const fetch=vi.fn(async()=>Response.json(body)),assertScope=vi.fn();return{directory,body,review,plan,fetch,assertScope,file,now,options:{directory,plan,review,version:plan.candidateVersion,fetch:fetch as typeof globalThis.fetch,assertScope}};
}
it('uses only the fixed status GET and retains aggregate history proof',async()=>{const f=fixture();try{await verifyMonitorRead(f.options,new AbortController().signal);expect(f.fetch).toHaveBeenCalledTimes(1);expect(f.fetch.mock.calls[0]).toMatchObject(['https://staging-status.porchday.com/status',{redirect:'error',cache:'no-store'}]);expect(f.assertScope).toHaveBeenCalledTimes(2);const records=readdirSync(f.directory).filter(x=>!['baseline.json','overlap.json','compatibility.json'].includes(x));expect(records).toHaveLength(1);const record=JSON.parse(readFileSync(join(f.directory,records[0]),'utf8'));expect(record).toMatchObject({kind:'monitor-history',version:f.plan.candidateVersion,detail:{current:{history:{passed:7,failed:2}}}});}finally{rmSync(f.directory,{recursive:true,force:true});}});
it.each(['missing','tampered','wrong-source','wrong-environment'] as const)('rejects %s pinned evidence before network',async kind=>{const f=fixture();try{if(kind==='missing')delete f.review.monitor;if(kind==='tampered')writeFileSync(f.review.monitor!.storageCompatibility.path,'{}');if(kind==='wrong-source')f.plan.candidateSource='d'.repeat(40);if(kind==='wrong-environment')f.plan.worker='porchday-monitor-production';await expect(verifyMonitorRead(f.options,new AbortController().signal)).rejects.toThrow();expect(f.fetch).not.toHaveBeenCalled();}finally{rmSync(f.directory,{recursive:true,force:true});}});
it.each(['stale','history-reset','failed-count','http','oversized'] as const)('cannot accept %s status as successful verification',async kind=>{const f=fixture();try{const body=structuredClone(f.body);if(kind==='stale')body.last_checked_at=new Date(Date.now()-90001).toISOString();if(kind==='history-reset')body.availability.first_observation_at=new Date(Date.now()-60000).toISOString();if(kind==='failed-count')body.availability.failed_minutes=0;f.fetch.mockImplementation(async()=>kind==='oversized'?new Response('x'.repeat(16385)):Response.json(body,{status:kind==='http'?503:200}));await expect(verifyMonitorRead(f.options,new AbortController().signal)).rejects.toThrow();expect(readdirSync(f.directory)).toHaveLength(3);}finally{rmSync(f.directory,{recursive:true,force:true});}});
it('does not allow monitor evidence to be applied to an application release',()=>{const f=fixture();try{expect(()=>readMonitorReview({...f.plan,worker:'porchday-staging'},f.review)).toThrow('MONITOR_SCOPE_CHANGED');}finally{rmSync(f.directory,{recursive:true,force:true});}});

function recoveryFixture(){
 const f=fixture(),at=f.now-120*60000,body=structuredClone(f.body);
 body.last_checked_at=new Date(at).toISOString();body.availability.first_observation_at=new Date(at-9*60000).toISOString();
 f.review.monitor!.baseline=f.file('baseline.json',{environment:'staging',at,status:200,body});
 const incident={version:1,mode:'unavailable-baseline',baselineVersion:f.plan.baselineVersion,baselineSource:'c'.repeat(40),candidateSource:f.plan.candidateSource,failure:{environment:'staging',at:Date.now()-1000,status:503,body:{status:'unknown',last_checked_at:null,metrics_monitoring:'unavailable'}},evidence:[f.file('historical-origin.json',{at,body})]};
 f.review.monitor!.incidentRecovery=f.file('incident.json',incident);
 const current=structuredClone(body);current.last_checked_at=new Date(f.now).toISOString();current.availability.expected_minutes=130;current.availability.unknown_minutes=121;current.availability.observed_percent=Math.round(9/130*100000)/1000;current.availability.conservative_pass_percent=Math.round(7/130*100000)/1000;
 return{...f,incident,current,at};
}
it('records a fresh unavailable baseline only for explicit pre-activation recovery; never declares it healthy after deployment',async()=>{
 const f=recoveryFixture();try{
  f.fetch.mockImplementation(async()=>Response.json(f.incident.failure.body,{status:503}));
  expect(await verifyMonitorRead({...f.options,version:f.plan.baselineVersion,phase:'before-activation'},new AbortController().signal)).toBe(null);
  const records=readdirSync(f.directory).map(n=>JSON.parse(readFileSync(join(f.directory,n),'utf8'))).filter(v=>v.kind);
  expect(records).toHaveLength(1);expect(records[0]).toMatchObject({kind:'monitor-unavailable-baseline',detail:{status:503,historicalBaseline:{at:f.at}}});
  for(const version of [f.plan.candidateVersion,f.plan.baselineVersion])await expect(verifyMonitorRead({...f.options,version},new AbortController().signal)).rejects.toThrow('STATUS_INVALID');
  await expect(verifyMonitorRead({...f.options,phase:'before-activation'},new AbortController().signal)).rejects.toThrow('SCOPE_CHANGED');
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
it('requires fresh recovered history with no lost observations and keeps ordinary release age checks',async()=>{
 const f=recoveryFixture();try{
  f.fetch.mockImplementation(async()=>Response.json(f.current));
  expect((await verifyMonitorRead(f.options,new AbortController().signal))?.history).toMatchObject({expected:130,passed:7,failed:2});
  delete f.review.monitor!.incidentRecovery;await expect(verifyMonitorRead(f.options,new AbortController().signal)).rejects.toThrow('BASELINE_EXPIRED');
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
it.each(['wrong-version','wrong-source','stale-failure','future-failure','old-history','missing-proof','tampered-proof'] as const)('rejects invalid recovery evidence before network: %s',async kind=>{
 const f=recoveryFixture();try{
  if(kind==='wrong-version')f.incident.baselineVersion=uuid(20);
  if(kind==='wrong-source')f.incident.candidateSource='f'.repeat(40);
  if(kind==='stale-failure')f.incident.failure.at=Date.now()-31*60000;
  if(kind==='future-failure')f.incident.failure.at=Date.now()+60000;
  if(kind==='old-history'){const b=JSON.parse(readFileSync(f.review.monitor!.baseline.path,'utf8'));b.at-=5*60*60000;b.body.last_checked_at=new Date(b.at).toISOString();b.body.availability.first_observation_at=new Date(b.at-9*60000).toISOString();f.review.monitor!.baseline=f.file('baseline.json',b);}
  if(kind==='missing-proof')f.incident.evidence=[];
  if(kind==='tampered-proof')writeFileSync(f.incident.evidence[0].path,'changed');
  f.review.monitor!.incidentRecovery=f.file('incident.json',f.incident);
  await expect(verifyMonitorRead(f.options,new AbortController().signal)).rejects.toThrow();expect(f.fetch).not.toHaveBeenCalled();
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
it.each(['origin','lost-failures','metrics','other-error'] as const)('recovery never permits %s',async kind=>{
 const f=recoveryFixture();try{
  if(kind==='origin')f.current.availability.first_observation_at=new Date(f.now).toISOString();
  if(kind==='lost-failures'){f.current.availability.failed_minutes=1;f.current.availability.unknown_minutes=122;f.current.availability.observed_percent=Math.round(8/130*100000)/1000;}
  if(kind==='metrics')f.current.metrics_monitoring='unavailable';
  f.fetch.mockImplementation(async()=>kind==='other-error'?Response.json({error:'not monitor failure'},{status:502}):Response.json(f.current));
  await expect(verifyMonitorRead({...f.options,...(kind==='other-error'?{version:f.plan.baselineVersion,phase:'before-activation' as const}:{})},new AbortController().signal)).rejects.toThrow();
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

it('waits only with public GETs until a natural observation is fresh and preserves its timestamp diagnostics',async()=>{
 vi.useFakeTimers();const f=recoveryFixture();try{
  let reads=0;f.fetch.mockImplementation(async()=>++reads<3?Response.json(f.incident.failure.body,{status:503}):Response.json(f.current));
  const pending=waitForMonitorRecovery(f.options,new AbortController().signal);await vi.advanceTimersByTimeAsync(4001);expect(await pending).toBe(true);expect(reads).toBe(3);
  expect(f.fetch.mock.calls.every(call=>String(call[0]).endsWith('/status'))).toBe(true);
  const records=readdirSync(f.directory).map(n=>JSON.parse(readFileSync(join(f.directory,n),'utf8')));expect(records.filter(r=>r.kind==='monitor-recovery-read')).toHaveLength(3);expect(records.some(r=>r.kind==='monitor-observation-window'&&r.detail.ready===true)).toBe(true);
 }finally{vi.useRealTimers();rmSync(f.directory,{recursive:true,force:true});}
});
it('retains a fixed75-second deadline across restarts and stops polling after expiration',async()=>{
 vi.useFakeTimers();const f=recoveryFixture();try{
  f.fetch.mockImplementation(async()=>Response.json(f.incident.failure.body,{status:503}));
  const pending=waitForMonitorRecovery(f.options,new AbortController().signal);await vi.advanceTimersByTimeAsync(75001);expect(await pending).toBe(false);const reads=f.fetch.mock.calls.length;expect(reads).toBeLessThanOrEqual(38);
  expect(await waitForMonitorRecovery(f.options,new AbortController().signal)).toBe(false);expect(f.fetch).toHaveBeenCalledTimes(reads);
 }finally{vi.useRealTimers();rmSync(f.directory,{recursive:true,force:true});}
});
it('waits for stale but structurally valid history, but rejects history loss without spending the window',async()=>{
 vi.useFakeTimers();const f=recoveryFixture();try{
  const stale={...f.current,last_checked_at:new Date(f.now-3*60000).toISOString()};let calls=0;
  f.fetch.mockImplementation(async()=>Response.json(++calls===1?stale:{...f.current,availability:{...f.current.availability,first_observation_at:new Date(f.now).toISOString()}}));
  const pending=waitForMonitorRecovery(f.options,new AbortController().signal);const rejected=expect(pending).rejects.toThrow('HISTORY_CHANGED');await vi.advanceTimersByTimeAsync(2001);await rejected;expect(calls).toBe(2);
 }finally{vi.useRealTimers();rmSync(f.directory,{recursive:true,force:true});}
});
it('cannot apply a recovery wait to normal releases and honors cancellation without another read',async()=>{
 const f=recoveryFixture();try{
  const aborted=new AbortController();aborted.abort();await expect(waitForMonitorRecovery(f.options,aborted.signal)).rejects.toThrow();expect(f.fetch).not.toHaveBeenCalled();
  delete f.review.monitor!.incidentRecovery;await expect(waitForMonitorRecovery(f.options,new AbortController().signal)).rejects.toThrow('SCOPE_INVALID');expect(f.fetch).not.toHaveBeenCalled();
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

it('resumes a previously ready window with one current read instead of another wait',async()=>{
 vi.useFakeTimers();const f=recoveryFixture();try{
  f.fetch.mockImplementation(async()=>Response.json(f.current));expect(await waitForMonitorRecovery(f.options,new AbortController().signal)).toBe(true);
  await vi.advanceTimersByTimeAsync(76000);
  const elapsed=Math.floor(Date.now()/60000)-Math.floor(f.now/60000);f.current.last_checked_at=new Date(Date.now()).toISOString();f.current.availability.expected_minutes+=elapsed;f.current.availability.passed_minutes+=elapsed;
  f.current.availability.observed_percent=Math.round((9+elapsed)/(130+elapsed)*100000)/1000;f.current.availability.conservative_pass_percent=Math.round((7+elapsed)/(130+elapsed)*100000)/1000;
  expect(await waitForMonitorRecovery(f.options,new AbortController().signal)).toBe(true);expect(f.fetch).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();rmSync(f.directory,{recursive:true,force:true});}
});

it('waits for naturally aged unknown status and unavailable metrics, then requires both to recover',async()=>{
 vi.useFakeTimers();const f=recoveryFixture();try{
  const aged={...f.current,status:'unknown',metrics_monitoring:'unavailable',last_checked_at:new Date(f.now-10*60000).toISOString()};let reads=0;
  f.fetch.mockImplementation(async()=>Response.json(++reads===1?aged:f.current));
  const pending=waitForMonitorRecovery(f.options,new AbortController().signal);await vi.advanceTimersByTimeAsync(2001);expect(await pending).toBe(true);expect(reads).toBe(2);
  const records=readdirSync(f.directory).map(n=>JSON.parse(readFileSync(join(f.directory,n),'utf8'))).filter(r=>r.kind==='monitor-recovery-read');expect(records[0].detail).toMatchObject({status:'unknown',metrics:'unavailable',httpStatus:200});
 }finally{vi.useRealTimers();rmSync(f.directory,{recursive:true,force:true});}
});
it('never interprets aged unknown status as successful normal verification',async()=>{
 const f=recoveryFixture();try{
  f.fetch.mockImplementation(async()=>Response.json({...f.current,status:'unknown',metrics_monitoring:'unavailable',last_checked_at:new Date(f.now-10*60000).toISOString()}));
  await expect(verifyMonitorRead(f.options,new AbortController().signal)).rejects.toThrow('STATUS_INVALID');
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
