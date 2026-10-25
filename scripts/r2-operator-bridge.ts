import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve4,resolve6,resolveCname,Resolver} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import type {JournalStore} from '../apps/api/src/privacy-journal.js';

type Bridge = {journal:JournalStore;deleteMediaObject(key:string):Promise<void>;verifyConditionalWrites():Promise<void>};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** A temporary private capability, never written to stdout, disk or command arguments. */
export async function withOperatorR2<T>(options:{journalBucket:string;mediaBucket?:string;journalAccess?:'read-only'|'read-write';hostname?:string;onProgress?:(phase:string)=>void},work:(bridge:Bridge)=>Promise<T>):Promise<T> {
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
  if(!account||!token)throw Error('CLOUDFLARE_OPERATOR_CREDENTIALS_REQUIRED');
  const hostname=options.hostname??'ops.porchday.com';
  if(!/^ops(?:-[a-f0-9]{8})?\.porchday\.com$/.test(hostname))throw Error('OPERATOR_HOSTNAME_INVALID');
  for(const name of [options.journalBucket,options.mediaBucket].filter(Boolean))if(!/^porchday-[a-z0-9-]+$/.test(name!))throw Error('OPERATOR_BUCKET_INVALID');
  if(options.mediaBucket===options.journalBucket)throw Error('OPERATOR_BUCKETS_MUST_DIFFER');
  const bearer=randomBytes(32).toString('base64url'),script='porchday-ops-'+randomUUID().replaceAll('-','');
  async function api(path:string,method='GET',body?:unknown):Promise<any> {
    let response:Response;
    try{response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+token,...(body!==undefined && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});}catch{throw Error('OPERATOR_API_UNAVAILABLE');}
    let data:any;const text=await response.text();if(method==='DELETE'&&response.ok&&!text)return null;try{data=JSON.parse(text);}catch{throw Error('OPERATOR_API_INVALID_RESPONSE');}
    if(!response.ok||data.success!==true)throw Error('OPERATOR_API_'+(path.startsWith('/zones?')?'ZONES':path.includes('/dns_records')?'DNS':path.includes('/domains')?'DOMAINS':'SCRIPTS')+'_'+method+'_'+response.status+'_'+String(data.errors?.[0]?.code??0));return data.result;
  }
  const zones=await api('/zones?name=porchday.com'),zone=zones?.[0]?.id;
  if(!zone)throw Error('OPERATOR_ZONE_MISSING');
  const domains=await api('/accounts/'+account+'/workers/domains');
  if(domains.some((d:any)=>d.hostname===hostname))throw Error('OPERATOR_HOSTNAME_IN_USE');
  // Custom Domains manage their own DNS. This token need not read or edit
  // arbitrary DNS records; fail if public origin records or another Worker exist.
  for(const lookup of [resolve4,resolve6,resolveCname]){
    try{if((await lookup(hostname)).length)throw Error('OPERATOR_DNS_IN_USE');}
    catch(error){if(!['ENOTFOUND','ENODATA'].includes(String((error as NodeJS.ErrnoException).code)))throw Error('OPERATOR_DNS_NOT_CONFIRMED_UNUSED');}
  }
  const authoritative=new Resolver({timeout:3000,tries:2});
  const nameserver=zones[0].name_servers?.[0];if(!nameserver)throw Error('OPERATOR_NAMESERVER_MISSING');
  authoritative.setServers(await resolve4(nameserver));
  // Public preflight can populate an OS negative cache. Resolve this new custom
  // domain at its authoritative server while retaining normal TLS verification.
  async function requestBridge(path:string,body:unknown,authorized=true):Promise<Response>{
    const [address]=await authoritative.resolve4(hostname);if(!address)throw Error('OPERATOR_DNS_NOT_READY');
    return new Promise((resolve,reject)=>{
      const request=httpsRequest({hostname,servername:hostname,path,method:'POST',lookup:(_host,options,callback)=>{
        if(typeof options==='object'&&options.all)callback(null,[{address,family:4}] as never);else callback(null,address,4);
      },headers:{...(authorized?{Authorization:'Bearer '+bearer}:{}),'Content-Type':'application/json'},timeout:15_000},response=>{
        const chunks:Buffer[]=[];let size=0;
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>6*1024*1024){request.destroy();reject(Error('OPERATOR_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
        response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode??503})));response.on('error',()=>reject(Error('OPERATOR_BRIDGE_UNAVAILABLE')));
      });
      request.on('timeout',()=>request.destroy(Error('OPERATOR_BRIDGE_TIMEOUT')));request.on('error',()=>reject(Error('OPERATOR_BRIDGE_UNAVAILABLE')));request.end(JSON.stringify(body));
    });
  }
  let deployed=false,domainId:string|undefined;
  async function call(path:string,body:unknown):Promise<Response> {
    try{return await requestBridge(path,body);}catch{throw Error('OPERATOR_BRIDGE_UNAVAILABLE');}
  }
  const journal:JournalStore={
    async get(key){const response=await call('/journal/get',{key});if(response.status===404)return null;if(!response.ok)throw Error('OPERATOR_READ_FAILED');const value=await response.json() as {etag:string;value:string};if(typeof value.etag!=='string'||typeof value.value!=='string')throw Error('OPERATOR_RESPONSE_INVALID');return {etag:value.etag,text:async()=>value.value};},
    async put(key,value,condition){const response=await call('/journal/put',{key,value,ifMatch:condition?.onlyIf?.etagMatches,ifNoneMatch:condition?.onlyIf?.etagDoesNotMatch});if(response.status===412)return null;if(!response.ok)throw Error('OPERATOR_WRITE_FAILED');const result=await response.json() as {etag:string};if(typeof result.etag!=='string')throw Error('OPERATOR_RESPONSE_INVALID');return {etag:result.etag};},
  };
  const bridge:Bridge={journal,
    async deleteMediaObject(key){if(!(await call('/media/delete',{key})).ok)throw Error('OPERATOR_MEDIA_DELETE_FAILED');},
    async verifyConditionalWrites(){
      const key='probes/'+randomUUID()+'.json';
      try{
        const first=await journal.put(key,'{"probe":1}',{onlyIf:{etagDoesNotMatch:'*'}});
        if(!first||await journal.put(key,'{"probe":2}',{onlyIf:{etagDoesNotMatch:'*'}}))throw Error('OPERATOR_CAS_UNSUPPORTED');
        const second=await journal.put(key,'{"probe":2}',{onlyIf:{etagMatches:first.etag}});
        if(!second||second.etag===first.etag||await journal.put(key,'{"probe":3}',{onlyIf:{etagMatches:first.etag}}))throw Error('OPERATOR_CAS_UNSUPPORTED');
        const current=await journal.get(key);if(!current||current.etag!==second.etag||await current.text()!=='{"probe":2}')throw Error('OPERATOR_CAS_UNSUPPORTED');
      }finally{if(!(await call('/probe/delete',{key})).ok)throw Error('OPERATOR_PROBE_CLEANUP_FAILED');}
    },
  };
  try{
    const metadata={main_module:'operator.mjs',compatibility_date:'2026-10-01',observability:{enabled:false},bindings:[{type:'secret_text',name:'OPERATOR_BEARER',text:bearer},{type:'plain_text',name:'OPERATOR_EXPIRES_AT',text:String(Date.now()+60*60*1000)},{type:'plain_text',name:'JOURNAL_ACCESS',text:options.journalAccess??'read-write'},{type:'r2_bucket',name:'JOURNAL',bucket_name:options.journalBucket},...(options.mediaBucket?[{type:'r2_bucket',name:'MEDIA',bucket_name:options.mediaBucket}]:[])]};
    const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.set('operator.mjs',new Blob([await readFile(new URL('./r2-operator-worker.mjs',import.meta.url),'utf8')],{type:'application/javascript+module'}),'operator.mjs');
    await api('/accounts/'+account+'/workers/scripts/'+script,'PUT',form);deployed=true;
    const domain=await api('/accounts/'+account+'/workers/domains','PUT',{hostname,service:script,enabled:true,previews_enabled:false,zone_id:zone});domainId=domain.id;if(typeof domainId!=='string')throw Error('OPERATOR_DOMAIN_RESPONSE_INVALID');options.onProgress?.('domain-attached-enabled-'+String(domain.enabled));
    let ready=false;for(let attempt=0;attempt<45;attempt++){try{const response=await call('/health',{});if(response.ok){ready=true;break;}options.onProgress?.('health-status-'+response.status);}catch{options.onProgress?.('health-not-yet-reachable');}await pause(1000);}
    if(!ready)throw Error('OPERATOR_HOSTNAME_NOT_READY');
    const unauthenticated=await requestBridge('/journal/put',{},false);
    if(unauthenticated.status!==401)throw Error('OPERATOR_AUTH_PROBE_FAILED');
    await bridge.verifyConditionalWrites();
    return await work(bridge);
  }finally{
    let failed=false;
    if(domainId){try{await api('/accounts/'+account+'/workers/domains/'+domainId,'DELETE');}catch{failed=true;}}
    if(deployed){try{await api('/accounts/'+account+'/workers/scripts/'+script,'DELETE');}catch{failed=true;}}
    if(deployed&&!failed){try{
      const remainingDomains=await api('/accounts/'+account+'/workers/domains');
      const remainingScripts=await api('/accounts/'+account+'/workers/scripts');
      if(remainingDomains.some((d:any)=>d.service===script)||remainingScripts.some((s:any)=>s.id===script))failed=true;
    }catch{failed=true;}}
    if(failed)throw Error('OPERATOR_TEARDOWN_REQUIRED');
  }
}
