import {readProviderJson,ProviderBodyTransportError} from './provider-response-body.ts';
import type {DeploymentWriteEvent} from './deployment-write-receipts.ts';
import {RecoveryError,RetryableObservationError,type DeploymentObservation,recoveryTarget} from './deployment-recovery.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const marker='porchday-recovery:';
/** Narrow transport: one Worker, no retries of POSTs, no credentials or provider bodies in errors. */
export class CloudflareDeploymentClient{
 private readonly endpoint:string;
 private readonly token:string;
 private readonly request:typeof fetch;
 private readonly retain?:(event:DeploymentWriteEvent)=>void;
 constructor(options:{accountId:string;worker:string;apiToken:string;fetch?:typeof fetch;retain?:(event:DeploymentWriteEvent)=>void}){
  recoveryTarget(options.worker);
  if(!/^[a-f0-9]{32}$/.test(options.accountId)||typeof options.apiToken!=='string'||options.apiToken.length<20)throw new RecoveryError('DEPLOYMENT_PROVIDER_CONFIGURATION_INVALID');
  this.endpoint='https://api.cloudflare.com/client/v4/accounts/'+options.accountId+'/workers/scripts/'+options.worker+'/deployments';this.token=options.apiToken;this.request=options.fetch??fetch;this.retain=options.retain;
 }
 async observe(signal:AbortSignal):Promise<DeploymentObservation>{
  let response:Response;
  try{response=await this.request(this.endpoint,{headers:{Authorization:'Bearer '+this.token},redirect:'error',signal});}catch{throw new RetryableObservationError();}
  if([408,429,500,502,503,504].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new RetryableObservationError();}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new RecoveryError('DEPLOYMENT_PROVIDER_READ_REJECTED');}
  let value:unknown;try{value=await readProviderJson(response);}catch(error){if(error instanceof ProviderBodyTransportError)throw new RetryableObservationError();throw new RecoveryError('DEPLOYMENT_PROVIDER_RESPONSE_INVALID');}
  const data=value as {success?:boolean;result?:{deployments?:{id?:unknown;versions?:{version_id?:unknown;percentage?:unknown}[];annotations?:Record<string,unknown>}[]}};
  const current=data?.result?.deployments?.[0],versions=current?.versions;
  if(data?.success!==true||!current||typeof current.id!=='string'||!uuid.test(current.id)||!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||typeof versions[0].version_id!=='string'||!uuid.test(versions[0].version_id))throw new RecoveryError('DEPLOYMENT_PROVIDER_STATE_UNSUPPORTED');
  const message=current.annotations?.['workers/message'];const operationId=typeof message==='string'&&message.startsWith(marker)&&uuid.test(message.slice(marker.length))?message.slice(marker.length):null;
  return{version:versions[0].version_id,deploymentId:current.id,operationId};
 }
 async deploy(version:string,operationId:string,signal:AbortSignal):Promise<void>{
  if(!uuid.test(version)||!uuid.test(operationId))throw new RecoveryError('DEPLOYMENT_PROVIDER_WRITE_INVALID');
  signal.throwIfAborted();
  const record=(event:Omit<DeploymentWriteEvent,'operationId'|'version'|'at'>)=>this.retain?.({...event,operationId,version,at:new Date().toISOString()});
  // Failure to durably retain intent prevents the POST. A repeated invocation
  // cannot overwrite the original receipt and silently dispatch again.
  record({kind:'intent'});signal.throwIfAborted();
  let response:Response;
  try{response=await this.request(this.endpoint,{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},redirect:'error',signal,body:JSON.stringify({strategy:'percentage',versions:[{version_id:version,percentage:100}],annotations:{'workers/message':marker+operationId}})});}
  catch{record({kind:'transport-error'});throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');}
  let value:any,bodyState:'json'|'invalid'='json';try{value=await readProviderJson(response);}catch{bodyState='invalid';}
  const rawRay=response.headers.get('cf-ray'),ray=rawRay&&/^[a-zA-Z0-9-]{1,80}$/.test(rawRay)?rawRay:undefined;
  const errors=Array.isArray(value?.errors)?value.errors.slice(0,8).map((e:any)=>({...(Number.isSafeInteger(e?.code)?{code:e.code}:{}),...(typeof e?.message==='string'?{message:e.message.split(this.token).join('[redacted]').slice(0,512)}:{})})):undefined;
  record({kind:'response',status:response.status,...(ray?{ray}:{}),bodyState,...(typeof value?.success==='boolean'?{success:value.success}:{}),...(errors?{errors}:{})});
  // Even a provider error remains uncertain until independent reconciliation.
  if(!response.ok||bodyState!=='json'||value?.success!==true)throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');
 }
}
