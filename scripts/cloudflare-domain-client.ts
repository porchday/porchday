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
 private async call(method:'GET'|'POST'|'PUT',body?:unknown,endpoint=this.endpoint):Promise<unknown>{
  const signal=AbortSignal.timeout(10000);
  try{
   const response=await this.request(endpoint,{method,signal,redirect:'error',headers:{Authorization:'Bearer '+this.options.apiToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(!response.ok){await response.body?.cancel();throw Error('status');}
   const reader=response.body?.getReader();if(!reader)throw Error('body');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw Error('size');chunks.push(value);}}
   finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   const data=JSON.parse(new TextDecoder().decode(bytes));if(data?.success!==true)throw Error('success');
   return data.result;
  }catch{throw Error(method==='PUT'?'DOMAIN_WRITE_UNCONFIRMED':'DOMAIN_OBSERVATION_UNAVAILABLE');}
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
 async assign(target:DomainTarget,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  const move=this.plan.moves.find(m=>m.before.hostname===target.hostname);
  const same=(a:DomainTarget)=>a.hostname===target.hostname&&a.service===target.service&&a.environment===target.environment&&a.zoneId===target.zoneId;
  if(!move||![move.before,move.after].some(same))throw Error('DOMAIN_OUTSIDE_PLAN');
  const domains=await this.call('GET');
  if(!Array.isArray(domains))throw Error('DOMAIN_RESPONSE_INVALID');
  const owned=domains.filter(d=>d?.service===target.service);
  // The Worker-scoped endpoint replaces its domain set. Preserve every current
  // destination domain and refuse ownership outside this reviewed plan.
  const selected=domains.filter(d=>d?.hostname===target.hostname);
  if(selected.length!==1)throw Error('DOMAIN_RESPONSE_INVALID');
  const current=selected[0];
  if(current.service===target.service)throw Error('DOMAIN_ALREADY_ASSIGNED');
  const union=[...owned,current],names=new Set<string>();
  for(const d of union){
   const reviewed=this.plan.moves.find(m=>m.before.hostname===d.hostname);
   if(!reviewed||names.has(d.hostname)||d.zone_id!==reviewed.before.zoneId||d.environment!=='production'||d.enabled!==true||d.previews_enabled!==false||![reviewed.before.service,reviewed.after.service].includes(d.service))throw Error('DOMAIN_DESTINATION_SCOPE_CHANGED');
   names.add(d.hostname);
  }
  const origins=union.map(d=>({hostname:d.hostname,zone_id:d.zone_id,enabled:true,previews_enabled:false})).sort((a,b)=>a.hostname.localeCompare(b.hostname));
  const endpoint=this.endpoint.replace(/\/domains$/,`/scripts/${target.service}/domains`);
  signal?.throwIfAborted();
  const preview=await this.call('POST',origins,endpoint+'/changeset?replace_state=true') as {added?:unknown[];removed?:unknown[];conflicting?:unknown[];updated?:Array<{hostname:string;zone_id:string;service:string;modified:boolean;enabled:boolean;previews_enabled:boolean}>};
  if(!preview||!Array.isArray(preview.added)||preview.added.length||!Array.isArray(preview.removed)||preview.removed.length||!Array.isArray(preview.conflicting)||preview.conflicting.length||!Array.isArray(preview.updated))throw Error('DOMAIN_CHANGESET_UNSAFE');
  const previewNames=new Set<string>();
  for(const d of preview.updated){
   const origin=origins.find(o=>o.hostname===d?.hostname);
   if(!origin||previewNames.has(d.hostname)||d.zone_id!==origin.zone_id||d.service!==target.service||d.enabled!==true||d.previews_enabled!==false||typeof d.modified!=='boolean')throw Error('DOMAIN_CHANGESET_UNSAFE');
   previewNames.add(d.hostname);
  }
  const changed=preview.updated.filter(d=>d.modified);
  if(changed.length!==1||changed[0].hostname!==target.hostname||changed[0].zone_id!==target.zoneId||changed[0].service!==target.service||changed[0].enabled!==true||changed[0].previews_enabled!==false||preview.updated.some(d=>!names.has(d.hostname)))throw Error('DOMAIN_CHANGESET_UNSAFE');
  // Wrangler uses this endpoint to move an existing origin. Never overwrite
  // unrelated DNS records, and never retry an uncertain PUT.
  signal?.throwIfAborted();
  await this.call('PUT',{override_scope:true,override_existing_origin:true,override_existing_dns_record:false,origins},endpoint+'/records');
 }
}
