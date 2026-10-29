/** Read-only, UTC bucket estimates for the external synthetic monitor's limited scope. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readdirSync,createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import type {Observation} from './external-monitor-probe.ts';
const cadence=20000,day=86400000,scope='login_authorized_reads_logout_and_readiness';
const checks=['anonymous_session','authorized_feed','authorized_profile','login','logout','monitor_freshness','protected_readiness','revocation'];
const failureCodes=['deadline','transport_or_response','dependency'];
const invalid=()=>new Error('AVAILABILITY_REPORT_INPUT_INVALID');
function timestamp(value:unknown):number{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))throw invalid();
 const at=Date.parse(value);if(!Number.isFinite(at)||new Date(at).toISOString()!==value)throw invalid();return at;
}
function validate(value:unknown):asserts value is Observation{
 const o=value as Observation;if(!o||o.v!==1||!['production','staging'].includes(o.environment)||o.scope!==scope||typeof o.healthy!=='boolean'||!Number.isFinite(o.durationMs)||o.durationMs<0||!Array.isArray(o.checks))throw invalid();
 timestamp(o.at);const expected=[...checks,...(o.environment==='production'?['legacy_anonymous_session']:[])].sort();
 if(JSON.stringify(o.checks.map(c=>c?.name).sort())!==JSON.stringify(expected))throw invalid();
 if(o.checks.some(c=>typeof c.ok!=='boolean'||c.status!==undefined&&(!Number.isInteger(c.status)||c.status<100||c.status>599)||c.durationMs!==undefined&&(!Number.isFinite(c.durationMs)||c.durationMs<0)||c.failure!==undefined&&!failureCodes.includes(c.failure)||c.ok&&(c.status!==(c.name==='revocation'?401:200)||c.failure!==undefined)||!c.ok&&c.status===undefined&&c.failure===undefined))throw invalid();
 if(o.healthy!==o.checks.every(c=>c.ok))throw invalid();
}
export function monthWindow(month:string):{start:number;end:number}{
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw invalid();const start=Date.parse(month+'-01T00:00:00.000Z');
 const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);return{start,end:end.getTime()};
}
export class AvailabilityWindow{
 private buckets=new Map<number,boolean>();private sampleCount=0;private failedSamples=0;private first:number|null=null;private last:number|null=null;
 private failedChecks=new Map<string,number>();private outsideAsOf=0;
 private applicationBuckets=new Map<number,boolean>();private monitorBuckets=new Map<number,boolean>();
 readonly start:number;readonly end:number;readonly asOf:number;readonly environment:'staging'|'production';
 constructor(start:number,end:number,asOf:number,environment:'staging'|'production'){
  this.start=start;this.end=end;this.asOf=asOf;this.environment=environment;
  if(![start,end,asOf].every(Number.isFinite)||end<=start||asOf<start)throw invalid();
 }
 add(value:unknown):void{
  validate(value);if(value.environment!==this.environment)return;const at=timestamp(value.at),stop=Math.min(this.asOf,this.end);
  if(at<this.start||at>=this.end)return;
  // A future or unfinished observation cannot establish coverage at the report cutoff.
  if(at>=stop||at+value.durationMs>stop){this.outsideAsOf++;return;}
  this.sampleCount++;this.first=this.first===null?at:Math.min(this.first,at);this.last=this.last===null?at:Math.max(this.last,at);
  if(!value.healthy){this.failedSamples++;for(const c of value.checks)if(!c.ok)this.failedChecks.set(c.name,(this.failedChecks.get(c.name)??0)+1);}
  const bucket=Math.floor(at/cadence)*cadence;
  // Credit only completed UTC buckets. Multiple samples never multiply time; any failure wins.
  if(bucket+cadence>stop)return;
  this.buckets.set(bucket,(this.buckets.get(bucket)??true)&&value.healthy);
  // Independent attribution uses the same validated observations and coverage.
  // Keep the combined result conservative; monitor failures still alert.
  const applicationHealthy=value.checks.filter(c=>c.name!=='monitor_freshness').every(c=>c.ok),monitorHealthy=value.checks.find(c=>c.name==='monitor_freshness')!.ok;
  this.applicationBuckets.set(bucket,(this.applicationBuckets.get(bucket)??true)&&applicationHealthy);
  this.monitorBuckets.set(bucket,(this.monitorBuckets.get(bucket)??true)&&monitorHealthy);
 }
 private summarize(buckets:Map<number,boolean>){
  const stop=Math.min(this.asOf,this.end),elapsedMs=stop-this.start;let healthyMs=0,failedMs=0;
  for(const [at,healthy] of buckets){const width=Math.max(0,Math.min(at+cadence,stop)-Math.max(at,this.start));if(healthy)healthyMs+=width;else failedMs+=width;}
  const knownMs=healthyMs+failedMs,unknownMs=elapsedMs-knownMs,windowMs=this.end-this.start;
  return{elapsedSeconds:elapsedMs/1000,estimatedHealthySeconds:healthyMs/1000,estimatedFailedSeconds:failedMs/1000,unknownSeconds:unknownMs/1000,
   coveragePercent:elapsedMs?knownMs/elapsedMs*100:0,sampledSuccessRatePercent:knownMs?healthyMs/knownMs*100:null,
   fullWindowErrorBudgetSeconds:windowMs*0.0001/1000,sampledFailureBudgetRatio:failedMs/(windowMs*0.0001),
   budgetAssessment:failedMs>windowMs*0.0001?'sampled-failures-exceed-budget':'not-established',sloStatus:'not-established'};
 }
 report(){
  const stop=Math.min(this.asOf,this.end);
  return{start:new Date(this.start).toISOString(),end:new Date(this.end).toISOString(),asOf:new Date(stop).toISOString(),completeWindow:this.asOf>=this.end,
   scope,environment:this.environment,method:'completed-20-second-UTC-buckets; any failure wins; no gap filling',
   collectionFirstObservation:this.first===null?null:new Date(this.first).toISOString(),collectionLastObservation:this.last===null?null:new Date(this.last).toISOString(),
   samples:this.sampleCount,failedSamples:this.failedSamples,ignoredFutureOrUnfinishedSamples:this.outsideAsOf,
   failedChecks:Object.fromEntries([...this.failedChecks].sort(([a],[b])=>a.localeCompare(b))),
   ...this.summarize(this.buckets),
   evidenceGroups:{
    applicationJourney:{checks:[...checks.filter(c=>c!=='monitor_freshness'),...(this.environment==='production'?['legacy_anonymous_session']:[])],...this.summarize(this.applicationBuckets)},
    monitorFreshness:{checks:['monitor_freshness'],...this.summarize(this.monitorBuckets)},
   },
   limitations:['Sampled buckets estimate this probe only; they do not measure continuous uptime.','Unobserved time and incidents before collection are not healthy observations.','Evidence groups attribute this probe only; a monitor failure does not by itself prove an application outage. Combined failures and alerts remain unchanged.','Encrypted writes, mail delivery, regional coverage and responder acknowledgment are not established by this report.']};
 }
}
export async function availabilityReport(directory:string,asOf:string,month=asOf.slice(0,7),environment:'staging'|'production'='production'){
 const now=timestamp(asOf),calendar=monthWindow(month);if(now<calendar.start)throw invalid();
 const windows={monthly:new AvailabilityWindow(calendar.start,calendar.end,now,environment),rolling30Days:new AvailabilityWindow(now-30*day,now,now,environment)};
 const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('AVAILABILITY_REPORT_PERMISSIONS');
 const inputs:{name:string;bytes:number;sha256:string}[]=[];
 for(const name of readdirSync(directory).sort()){
  const match=/^observations-(\d{4}-\d{2})\.jsonl$/.exec(name);if(!match)continue;
  const range=monthWindow(match[1]);if(!Object.values(windows).some(w=>range.start<Math.min(w.end,now)&&range.end>w.start))continue;
  const fd=openSync(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW),file=fstatSync(fd);
  if(!file.isFile()||(file.mode&0o077)!==0||file.uid!==process.getuid?.()||file.size>1024*1024*1024){closeSync(fd);throw new Error('AVAILABILITY_REPORT_PERMISSIONS');}
  const hash=createHash('sha256');let lastByte=-1;
  if(file.size){
   // Bound reads to the opening size: concurrent appends belong to the next report.
   const stream=createReadStream('',{fd,autoClose:true,start:0,end:file.size-1});stream.on('data',chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);hash.update(bytes);lastByte=bytes[bytes.length-1];});
   const lines=createInterface({input:stream,crlfDelay:Infinity});
   try{for await(const line of lines){if(!line||line.length>16384)throw invalid();let value:unknown;try{value=JSON.parse(line);}catch{throw invalid();}validate(value);if((value as Observation).at.slice(0,7)!==match[1])throw invalid();for(const window of Object.values(windows))window.add(value);}}
   finally{lines.close();stream.destroy();}
   if(lastByte!==10)throw new Error('AVAILABILITY_REPORT_TORN_HISTORY');
  }else closeSync(fd);
  inputs.push({name,bytes:file.size,sha256:hash.digest('hex')});
 }
 return{v:1,generatedFor:asOf,inputs,monthly:windows.monthly.report(),rolling30Days:windows.rolling30Days.report()};
}
async function main(){
 const args=process.argv.slice(2),options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!['--state-dir','--as-of','--month','--environment'].includes(args[i])||!args[i+1]||options.has(args[i]))throw invalid();options.set(args[i],args[i+1]);}
 const directory=options.get('--state-dir'),environment=options.get('--environment')??'production';if(!directory||!['production','staging'].includes(environment))throw invalid();
 const asOf=options.get('--as-of')??new Date().toISOString();console.log(JSON.stringify(await availabilityReport(resolve(directory),asOf,options.get('--month'),environment as 'production'|'staging'),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('AVAILABILITY_REPORT_FAILED: history was not treated as healthy; inspect inputs locally.');process.exitCode=1;});
