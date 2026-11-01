import {probeReleaseContinuity} from './release-continuity.ts';
import {verifyPublicAssets,type PublicAssetManifest} from './release-assets-verify.ts';
export type TrialConnections={at:number;total:number;usable:number;refused:boolean};
export type TrialMetrics={allErrors:{requests:number;server_errors:number}|null;refused:boolean;routes:readonly {route:string;code:string;count:number}[];coverage:string};
type Options={publicVersion:string;publicHeaders:Record<string,string>;publicCache:Record<string,string|null>;target:Parameters<typeof probeReleaseContinuity>[0]['target'];assets:PublicAssetManifest;assertScope:()=>void;fetch?:typeof fetch;
 readConnections:(signal:AbortSignal)=>Promise<TrialConnections|null>;
 readMetrics:(signal:AbortSignal,since:number)=>Promise<TrialMetrics>};
const routes=['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10'];
/** Synthetic owned-session GETs only. Never retain bodies, credentials, or
 * member identifiers. Database and provider reads are explicit bounded ports.
 */
export function createPlacementTrialCollector(input:Options){
 const options={...input,target:structuredClone(input.target),assets:structuredClone(input.assets)},transport=options.fetch??fetch;
 const origin=options.target.environment==='production'?'https://porchday.org':'https://staging.porchday.com';
 if(!/^[a-f0-9-]{36}$/.test(options.publicVersion)||!['content-security-policy','x-content-type-options','strict-transport-security'].every(k=>typeof options.publicHeaders[k]==='string'&&options.publicHeaders[k].length>0))throw Error('TRIAL_PUBLIC_BASELINE_REQUIRED');
 for(const path of Object.keys(options.assets.files).filter(p=>p!=='_headers')){const url=['index.html','app-shell.html'].includes(path)?'/app-shell':'/'+path;if(!Object.hasOwn(options.publicCache,url))throw Error('TRIAL_CACHE_BASELINE_REQUIRED');}
 const assert=(signal:AbortSignal)=>{signal.throwIfAborted();options.assertScope();};
 const window=async(signal:AbortSignal)=>{
  const startedAt=Date.now();
  const values=Object.fromEntries(routes.map(path=>[path,{attempts:0,errors:0,durations:[] as number[]}])) as Record<string,{attempts:number;errors:number;durations:number[]}>;
  let privacy=true,refused=false;
  for(let i=0;i<30;i++)for(const path of routes){
   assert(signal);const result=values[path],start=performance.now();result.attempts++;
   try{
    const response=await transport(origin+path,{method:'GET',redirect:'error',headers:{Cookie:options.target.cookie,Origin:origin},signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
    const reader=response.body?.getReader();if(!reader)throw Error('TRIAL_BODY_MISSING');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){assert(signal);const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('TRIAL_BODY_LIMIT');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    assert(signal);const body=JSON.parse(Buffer.concat(chunks).toString());
    if(['53300','refused_53300','refused_53400','refused_hyperdrive'].includes(body?.error?.code))refused=true;
    if(response.status!==200)throw Error('TRIAL_REQUEST_FAILED');
    const isolated=path.includes('/feed')?Array.isArray(body?.items)&&body.items.length===0:body?.id===options.target.memberId;
    if(!isolated||!response.headers.get('cache-control')?.includes('no-store')){privacy=false;throw Error('TRIAL_PRIVACY_FAILED');}
    result.durations.push(performance.now()-start);
   }catch{assert(signal);result.errors++;}
   // Stop issuing reads immediately if a successful response violates scope.
   if(!privacy||refused)return{startedAt,endedAt:Date.now(),routes:values,privacy,refused};
  }
  return{startedAt,endedAt:Date.now(),routes:values,privacy,refused};
 };
 const collect=async({signal,at,startedAt,lastWindowAt,forceWindow=false}:{signal:AbortSignal;at:number;startedAt:number;lastWindowAt:number;forceWindow?:boolean})=>{
  assert(signal);
  const wanted=forceWindow||lastWindowAt===startedAt||Math.floor((at-startedAt)/300000)>Math.floor((lastWindowAt-startedAt)/300000);
  let headersOk=true;
  const publicFetch:typeof fetch=async(url,init)=>{const response=await transport(url,init),path=new URL(String(url)).pathname;
   if(!Object.entries(options.publicHeaders).every(([key,value])=>response.headers.get(key)===value)||response.headers.get('cache-control')!==options.publicCache[path])headersOk=false;
   return response;};
  const health=async()=>{const response=await transport(origin+'/health',{method:'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});const value=await response.json();return response.status===200&&value.status==='ok'&&value.release===options.publicVersion;};
  const results=await Promise.allSettled([
   probeReleaseContinuity({target:options.target,assertScope:options.assertScope,fetch:transport},signal),
   options.readConnections(signal),options.readMetrics(signal,wanted?lastWindowAt:at-60000),
   verifyPublicAssets(origin,options.assets,{fetch:publicFetch,signal}),
   wanted?window(signal):Promise.resolve(null),health(),
  ]);
  assert(signal);
  const connectionFailure=results[1].status==='rejected'?results[1].reason:undefined;
  for(const [index,result] of results.entries())if(result.status==='rejected'&&index!==1)throw Error('TRIAL_OBSERVATION_UNAVAILABLE');
  if(results[1].status==='rejected')results[1]={status:'fulfilled',value:null};
  const [continuity,connection,metrics,assets,measured,healthyRelease]=results.map(r=>(r as PromiseFulfilledResult<any>).value) as [Awaited<ReturnType<typeof probeReleaseContinuity>>,TrialConnections|null,TrialMetrics,Awaited<ReturnType<typeof verifyPublicAssets>>,Awaited<ReturnType<typeof window>>|null,boolean];
  const good=(name:string)=>continuity.checks.find(c=>c.name===name)?.ok===true;
  return {at:Date.now(),auth:good('authorized_profile')&&good('authorized_feed'),revocation:good('denied_profile'),
   privacy:good('authorized_profile')&&good('authorized_feed')&&(measured?.privacy??true),readiness:good('protected_readiness'),
   publicAssets:assets.healthy&&headersOk&&healthyRelease,connection,refused:connectionFailure?.message==='TRIAL_CONNECTION_REFUSED'||metrics.refused||!!connection?.refused||!!measured?.refused,
   window:measured?{startedAt:measured.startedAt,endedAt:measured.endedAt,routes:measured.routes,allErrors:metrics.allErrors,operationsWarning:!good('protected_readiness')}:null,
   continuity,routeConnections:metrics.routes,metricsCoverage:metrics.coverage};
 };
 return {collect};
}
