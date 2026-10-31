import {routingPlanHash,type RoutingPlan,type DomainTarget} from './domain-routing-recovery.ts';

/** Only existing, enabled, non-preview domains in the reviewed plan.
 * PUT is deliberately never retried. The routing journal reconciles its result.
 */
export class CloudflareDomainClient {
 private readonly endpoint:string;
 private readonly request:typeof fetch;
 private readonly plan:RoutingPlan;
 private readonly options:{accountId:string;apiToken:string;plan:RoutingPlan;fetch?:typeof fetch};
 constructor(options:{accountId:string;apiToken:string;plan:RoutingPlan;fetch?:typeof fetch}){
  this.options={...options};
  routingPlanHash(options.plan);
  if(!/^[a-f0-9]{32}$/.test(options.accountId)||options.apiToken.length<20)throw Error('DOMAIN_PROVIDER_CONFIGURATION_INVALID');
  this.plan=structuredClone(options.plan);
  this.endpoint=`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/workers/domains`;
  this.request=options.fetch??fetch;
 }
 private async call(method:'GET'|'PUT',body?:unknown):Promise<unknown>{
  const signal=AbortSignal.timeout(10000);
  try{
   const response=await this.request(this.endpoint,{method,signal,redirect:'error',headers:{Authorization:'Bearer '+this.options.apiToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(!response.ok){await response.body?.cancel();throw Error('status');}
   const reader=response.body?.getReader();if(!reader)throw Error('body');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw Error('size');chunks.push(value);}}
   finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   const data=JSON.parse(new TextDecoder().decode(bytes));if(data?.success!==true)throw Error('success');
   return data.result;
  }catch{throw Error(method==='GET'?'DOMAIN_OBSERVATION_UNAVAILABLE':'DOMAIN_WRITE_UNCONFIRMED');}
 }
 async observe(hostname:string):Promise<DomainTarget>{
  if(!this.plan.moves.some(m=>m.before.hostname===hostname))throw Error('DOMAIN_OUTSIDE_PLAN');
  const result=await this.call('GET');if(!Array.isArray(result))throw Error('DOMAIN_RESPONSE_INVALID');
  const matches=result.filter(d=>d?.hostname===hostname);
  if(matches.length!==1)throw Error('DOMAIN_RESPONSE_INVALID');
  const d=matches[0];
  if(d.enabled!==true||d.previews_enabled!==false||d.environment!=='production'||typeof d.service!=='string'||typeof d.zone_id!=='string')throw Error('DOMAIN_STATE_UNSUPPORTED');
  return {hostname:d.hostname,service:d.service,environment:d.environment,zoneId:d.zone_id};
 }
 async assign(target:DomainTarget):Promise<void>{
  const move=this.plan.moves.find(m=>m.before.hostname===target.hostname);
  const same=(a:DomainTarget)=>a.hostname===target.hostname&&a.service===target.service&&a.environment===target.environment&&a.zoneId===target.zoneId;
  if(!move||![move.before,move.after].some(same))throw Error('DOMAIN_OUTSIDE_PLAN');
  await this.call('PUT',{hostname:target.hostname,service:target.service,zone_id:target.zoneId,enabled:true,previews_enabled:false});
 }
}
