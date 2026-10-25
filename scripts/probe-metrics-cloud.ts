/** Synthetic-only provider verification. No database, R2 or member credentials. */
import {build} from 'esbuild';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve4,resolve6,resolveCname,Resolver} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';

async function main(){
 if(!process.argv.includes('--run'))throw Error('EXPLICIT_RUN_REQUIRED');
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!account||!token)throw Error('CLOUDFLARE_CREDENTIALS_REQUIRED');
 const hostname='metrics-check.porchday.com',dataset='porchday_metrics_verification_v1';
 const script='porchday-metrics-probe-'+randomUUID().replaceAll('-',''),startedAt=Math.floor(Date.now()/1000);
 const bearer=randomBytes(32).toString('base64url');
 async function api(path:string,method='GET',body?:unknown):Promise<any>{
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,...(body!==undefined&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  const text=await response.text();if(response.ok&&!text)return null;
  let value:any;try{value=JSON.parse(text);}catch{throw Error('API_RESPONSE_INVALID');}
  if(!response.ok||value.success!==true)throw Error('API_REQUEST_FAILED');return value.result;
 }
 const zones=await api('/zones?name=porchday.com'),zone=zones[0];
 if(!zone?.id||!zone.name_servers?.[0])throw Error('ZONE_MISSING');
 const domains=await api('/accounts/'+account+'/workers/domains');
 if(domains.some((row:any)=>row.hostname===hostname))throw Error('PROBE_HOST_IN_USE');
 for(const lookup of [resolve4,resolve6,resolveCname]){
  try{if((await lookup(hostname)).length)throw Error('PROBE_HOST_IN_USE');}
  catch(error){if(!['ENOTFOUND','ENODATA'].includes(String((error as NodeJS.ErrnoException).code)))throw Error('PROBE_HOST_NOT_CONFIRMED_UNUSED');}
 }
 const resolver=new Resolver({timeout:3000,tries:2});resolver.setServers(await resolve4(zone.name_servers[0]));
 async function request(path:string,authorized=true):Promise<number>{
  const[address]=await resolver.resolve4(hostname);if(!address)throw Error('PROBE_DNS_NOT_READY');
  return new Promise((resolve,reject)=>{
   const req=httpsRequest({hostname,servername:hostname,path,method:'POST',timeout:10000,lookup:(_host,options,callback)=>{
    if(typeof options==='object'&&options.all)callback(null,[{address,family:4}] as never);else callback(null,address,4);
   },headers:authorized?{Authorization:'Bearer '+bearer}:{}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode??503));response.on('error',()=>reject(Error('PROBE_REQUEST_FAILED')));});
   req.on('error',()=>reject(Error('PROBE_REQUEST_FAILED')));req.on('timeout',()=>req.destroy(Error('PROBE_REQUEST_TIMEOUT')));req.end();
  });
 }
 const source=`import {event} from './apps/api/src/telemetry.ts';
 export default {async fetch(request,env){
  if(!env.PROBE_BEARER||Date.now()>Number(env.PROBE_EXPIRES_AT)||!Number.isFinite(Number(env.PROBE_EXPIRES_AT)))return new Response(null,{status:401});
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('Bearer '+env.PROBE_BEARER)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.headers.get('authorization')||'')));
  let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];if(d)return new Response(null,{status:401});
  const path=new URL(request.url).pathname;
  if(path==='/health')return new Response(null,{status:204});
  if(path!=='/emit'||request.method!=='POST')return new Response(null,{status:404});
  let calls=0,failed=0;
  const observed={ENVIRONMENT:env.ENVIRONMENT,METRICS:{writeDataPoint(point){calls++;try{return env.METRICS.writeDataPoint(point);}catch(error){failed++;throw error;}}}};
  event('request',{route:'/api/v1/feed',method:'GET',status:200,durationMs:12},observed);
  event('error',{route:'/api/private/synthetic-secret-marker',code:'synthetic-secret-marker',environment:'synthetic-secret-marker',password:'synthetic-secret-marker',body:'synthetic-secret-marker',status:503},observed);
  return new Response(null,{status:calls===2&&failed===0?204:502});
 }};`;
 const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'metrics-probe.ts',loader:'ts'},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent'});
 let attemptedUpload=false,domainId:string|undefined;
 try{
  const form=new FormData();form.set('metadata',JSON.stringify({main_module:'probe.mjs',compatibility_date:'2026-10-24',observability:{enabled:false},logpush:false,bindings:[
   {type:'secret_text',name:'PROBE_BEARER',text:bearer},{type:'plain_text',name:'PROBE_EXPIRES_AT',text:String(Date.now()+10*60000)},
   {type:'plain_text',name:'ENVIRONMENT',text:'staging'},{type:'analytics_engine',name:'METRICS',dataset},
  ]}));form.set('probe.mjs',new Blob([bundle.outputFiles[0].text],{type:'application/javascript+module'}),'probe.mjs');
  attemptedUpload=true;await api('/accounts/'+account+'/workers/scripts/'+script,'PUT',form);
  const domain=await api('/accounts/'+account+'/workers/domains','PUT',{hostname,service:script,enabled:true,previews_enabled:false,zone_id:zone.id});domainId=domain.id;
  if(typeof domainId!=='string')throw Error('PROBE_DOMAIN_INVALID');
  let ready=false;for(let i=0;i<40;i++){try{if(await request('/health')===204){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}
  if(!ready)throw Error('PROBE_NOT_READY');
  if(await request('/emit',false)!==401)throw Error('PROBE_AUTH_FAILED');
  if(await request('/emit?token=synthetic-secret-marker')!==204)throw Error('PROBE_EMIT_FAILED');
  console.log('Metrics probe: authenticated synthetic points emitted.');
  let verified=false;
  for(let attempt=0;attempt<30;attempt++){
   const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/analytics_engine/sql',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:'SELECT * FROM '+dataset+' WHERE timestamp >= toDateTime('+startedAt+') LIMIT 10'});
   if(response.ok){const value=await response.json() as any;const rows=Array.isArray(value.data)?value.data:[];
    if(JSON.stringify(rows).includes('synthetic-secret-marker'))throw Error('PROBE_REDACTION_FAILED');
    const allowed=/^(timestamp|dataset|_sample_interval|index1|(?:blob|double)(?:[1-9]|1[0-9]|20))$/;
    if(rows.some((row:any)=>row.dataset!==dataset||Object.keys(row).some(key=>!allowed.test(key))))throw Error('PROBE_UNEXPECTED_METADATA');
    const requestRow=rows.find((row:any)=>row.blob3==='request'&&row.blob4==='/api/v1/feed'&&Number(row.double2)===12);
    const errorRow=rows.find((row:any)=>row.blob3==='error'&&row.blob4==='none'&&row.blob6==='none'&&Number(row.double1)===503);
    if(requestRow&&errorRow&&rows.every((row:any)=>row.blob1==='porchday_metrics_v1'&&row.blob2==='staging')){verified=true;break;}
   }
   if(attempt===14)console.log('Metrics probe: still waiting for provider query visibility.');
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!verified)throw Error('PROBE_INGEST_NOT_VERIFIED');
  console.log('Metrics probe: real ingest/query verified; malformed fields and request token absent.');
 }finally{
  let failed=false;
  // Reconcile by unique script name even if an upload/domain response was lost.
  if(attemptedUpload)try{
   const domains=await api('/accounts/'+account+'/workers/domains'),scripts=await api('/accounts/'+account+'/workers/scripts');
   for(const row of domains.filter((row:any)=>row.service===script))await api('/accounts/'+account+'/workers/domains/'+row.id,'DELETE');
   if(scripts.some((row:any)=>row.id===script))await api('/accounts/'+account+'/workers/scripts/'+script,'DELETE');
  }catch{failed=true;}
  if(attemptedUpload&&!failed)try{
   const domains=await api('/accounts/'+account+'/workers/domains'),scripts=await api('/accounts/'+account+'/workers/scripts');
   if(domains.some((row:any)=>row.service===script)||scripts.some((row:any)=>row.id===script))failed=true;
  }catch{failed=true;}
  if(failed){console.error('Metrics probe teardown needs operator attention for '+script);throw Error('PROBE_TEARDOWN_REQUIRED');}
  if(attemptedUpload)console.log('Metrics probe: temporary Worker and domain removal independently verified.');
 }
}
main().catch(error=>{const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'METRICS_PROBE_FAILED';console.error(code);process.exitCode=1;});
