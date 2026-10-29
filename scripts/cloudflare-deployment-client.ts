import {RecoveryError,RetryableObservationError,type DeploymentObservation} from './deployment-recovery.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const marker='porchday-recovery:';
class BodyTransportError extends Error{}
/** Narrow transport: one Worker, no retries of POSTs, no credentials or provider bodies in errors. */
export class CloudflareDeploymentClient{
 private readonly endpoint:string;
 private readonly token:string;
 private readonly request:typeof fetch;
 constructor(options:{accountId:string;worker:string;apiToken:string;fetch?:typeof fetch}){
  if(!/^[a-f0-9]{32}$/.test(options.accountId)||!/^porchday-(staging|production)$/.test(options.worker)||typeof options.apiToken!=='string'||options.apiToken.length<20)throw new RecoveryError('DEPLOYMENT_PROVIDER_CONFIGURATION_INVALID');
  this.endpoint='https://api.cloudflare.com/client/v4/accounts/'+options.accountId+'/workers/scripts/'+options.worker+'/deployments';this.token=options.apiToken;this.request=options.fetch??fetch;
 }
 async observe(signal:AbortSignal):Promise<DeploymentObservation>{
  let response:Response;
  try{response=await this.request(this.endpoint,{headers:{Authorization:'Bearer '+this.token},redirect:'error',signal});}catch{throw new RetryableObservationError();}
  if([408,429,500,502,503,504].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new RetryableObservationError();}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new RecoveryError('DEPLOYMENT_PROVIDER_READ_REJECTED');}
  let value:unknown;try{value=await boundedJson(response);}catch(error){if(error instanceof BodyTransportError)throw new RetryableObservationError();throw new RecoveryError('DEPLOYMENT_PROVIDER_RESPONSE_INVALID');}
  const data=value as {success?:boolean;result?:{deployments?:{id?:unknown;versions?:{version_id?:unknown;percentage?:unknown}[];annotations?:Record<string,unknown>}[]}};
  const current=data?.result?.deployments?.[0],versions=current?.versions;
  if(data?.success!==true||!current||typeof current.id!=='string'||!uuid.test(current.id)||!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||typeof versions[0].version_id!=='string'||!uuid.test(versions[0].version_id))throw new RecoveryError('DEPLOYMENT_PROVIDER_STATE_UNSUPPORTED');
  const message=current.annotations?.['workers/message'];const operationId=typeof message==='string'&&message.startsWith(marker)&&uuid.test(message.slice(marker.length))?message.slice(marker.length):null;
  return{version:versions[0].version_id,deploymentId:current.id,operationId};
 }
 async deploy(version:string,operationId:string,signal:AbortSignal):Promise<void>{
  if(!uuid.test(version)||!uuid.test(operationId))throw new RecoveryError('DEPLOYMENT_PROVIDER_WRITE_INVALID');
  let response:Response;
  try{response=await this.request(this.endpoint,{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},redirect:'error',signal,body:JSON.stringify({strategy:'percentage',versions:[{version_id:version,percentage:100}],annotations:{'workers/message':marker+operationId}})});}
  catch{throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');}
  // A lost or malformed reply does not establish whether the write committed.
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');}
  let value:unknown;try{value=await boundedJson(response);}catch{throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');}
  if((value as {success?:unknown})?.success!==true)throw new RecoveryError('DEPLOYMENT_WRITE_UNCONFIRMED');
 }
}
async function boundedJson(response:Response):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw Error('EMPTY');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){let item:ReadableStreamReadResult<Uint8Array>;try{item=await reader.read();}catch{throw new BodyTransportError();}const {done,value}=item;if(done)break;size+=value.byteLength;if(size>65536)throw Error('LARGE');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
