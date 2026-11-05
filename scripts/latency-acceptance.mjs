// Offline, unweighted observations only. Never reads credentials or sends traffic.
import {readFileSync, statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export const targets = Object.freeze({read:750,feed:1000,post:1000,edit:1000,reaction:1000,logout:1000,'warm-feed':1500,'cold-feed':3000,'first-photo':2000,feedback:100});
const oneOf=(value, choices)=>choices.includes(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function requireValue(condition){if(!condition)throw Error('INVALID_LATENCY_EVIDENCE');}
function keys(value, allowed){requireValue(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key)));}
export function percentile(values, p) {
 if(!values.length)return null;
 const sorted=[...values].sort((a,b)=>a-b);
 const value=sorted[Math.ceil(sorted.length*p)-1];
 return Number.isFinite(value)?value:'unbounded';
}
export function assessLatency(input) {
 keys(input,['version','runs']);requireValue(input.version===1&&Array.isArray(input.runs)&&input.runs.length>0&&input.runs.length<=1000);
 const identities=new Set();
 const reports=input.runs.map(run=>{
  keys(run,['id','environment','release','region','regionEvidence','platform','device','network','workload','operation','scenario','scope','startedAt','endedAt','expectedAttempts','samples']);
  requireValue(typeof run.id==='string'&&/^[a-z0-9-]{1,64}$/.test(run.id)&&!identities.has(run.id));identities.add(run.id);
  requireValue(oneOf(run.environment,['staging','production'])&&typeof run.release==='string'&&/^[a-f0-9]{40}$/.test(run.release));
  requireValue(oneOf(run.region,['us-west','us-east','manila'])&&oneOf(run.regionEvidence,['operator-attested','runner-location','unknown']));
  requireValue(oneOf(run.platform,['web','pwa','ios'])&&oneOf(run.device,['physical-phone','desktop','simulator']));
  requireValue(oneOf(run.network,['cellular','wifi','wired','emulated']));
  for(const field of ['workload','scenario'])requireValue(typeof run[field]==='string'&&/^[a-z0-9-]{1,64}$/.test(run[field]));
  requireValue(Object.hasOwn(targets,run.operation)&&oneOf(run.scope,['server','end-to-end']));
  // Logout includes the subsequent rejection probe; UI/photo milestones are client intervals.
  if(['logout','warm-feed','cold-feed','first-photo','feedback'].includes(run.operation))requireValue(run.scope==='end-to-end');
  const start=Date.parse(run.startedAt),end=Date.parse(run.endedAt);
  requireValue(typeof run.startedAt==='string'&&typeof run.endedAt==='string'&&Number.isFinite(start)&&Number.isFinite(end)&&end>start);
  requireValue(integer(run.expectedAttempts)&&run.expectedAttempts>0&&run.expectedAttempts<=1_000_000&&Array.isArray(run.samples)&&run.samples.length<=run.expectedAttempts);
  const seen=new Set(),times=[],counts={success:0,error:0,timeout:0};
  for(const sample of run.samples){
   keys(sample,['ordinal','elapsedMs','outcome']);
   requireValue(integer(sample.ordinal)&&sample.ordinal<run.expectedAttempts&&!seen.has(sample.ordinal));seen.add(sample.ordinal);
   requireValue(typeof sample.elapsedMs==='number'&&Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0&&sample.elapsedMs<=3_600_000&&oneOf(sample.outcome,['success','error','timeout']));
   counts[sample.outcome]++;
   // A fast 503 is not a fast successful operation; timeout duration is only a lower bound.
   times.push(sample.outcome==='success'?sample.elapsedMs:Infinity);
  }
  const missing=run.expectedAttempts-run.samples.length;
  const enough=run.samples.length>=10_000;
  const all=[...times,...Array(missing).fill(Infinity)];
  const percentiles=enough?{p50Ms:percentile(all,.5),p95Ms:percentile(all,.95),p99Ms:percentile(all,.99)}:{p50Ms:null,p95Ms:null,p99Ms:null};
  const blockers=[];
  if(!enough)blockers.push('fewer-than-10000-observed-attempts');
  if(missing)blockers.push('missing-attempt-records');
  if(run.regionEvidence==='unknown')blockers.push('region-unverified');
  if(run.scope==='end-to-end'&&(run.device!=='physical-phone'||!oneOf(run.network,['cellular','wifi'])))blockers.push('representative-phone-network-unverified');
  const p99=percentiles.p99Ms,target=targets[run.operation];
  const verdict=blockers.length?'insufficient-evidence':typeof p99==='number'&&p99<=target?'within-target':'above-target';
  const {samples,...metadata}=run;
  return {...metadata,observedAttempts:samples.length,...counts,missingAttempts:missing,targetMs:target,...percentiles,verdict,blockers,
   // Passing a percentile is never a reliability or seven-day release acceptance claim.
   reliabilityAcceptance:'not-assessed',failureRate:(counts.error+counts.timeout+missing)/run.expectedAttempts};
 });
 return {version:1,method:'nearest-rank; failures and missing attempts rank as unbounded; no regional/release/workload pooling',reports,
  releaseAcceptance:'not-assessed',remainingGates:['complete-operation-region-client-matrix','representative-client-journeys','no-reliability-regression','staging-before-production','verified-rollback','seven-day-production-observation']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||statSync(process.argv[2]).size>64*1024*1024)throw Error('INVALID_LATENCY_EVIDENCE');
  const result=assessLatency(JSON.parse(readFileSync(process.argv[2],'utf8')));
  console.log(JSON.stringify(result,null,2));
  if(result.reports.some(r=>r.verdict!=='within-target'))process.exitCode=2;
 }catch{console.error('INVALID_LATENCY_EVIDENCE');process.exitCode=1;}
}
