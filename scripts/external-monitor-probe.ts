/** External account-readiness probe. Only fixed checks/statuses leave this module. */
export type ProbeConfig={environment:'staging'|'production';healthToken:string;synthetic:{id:string;email:string;password:string}};
export type Check={name:string;ok:boolean;status?:number;durationMs?:number;failure?:'deadline'|'transport_or_response'|'dependency'};
export type Observation={v:1;at:string;environment:'staging'|'production';healthy:boolean;checks:Check[];durationMs:number;scope:'login_authorized_reads_logout_and_readiness'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateProbeConfig(config:ProbeConfig){
 if(!['staging','production'].includes(config.environment)||typeof config.healthToken!=='string'||config.healthToken.length<32
  ||!uuid.test(config.synthetic?.id??'')||config.synthetic?.email!==config.synthetic.id+'@example.test'
  ||typeof config.synthetic.password!=='string'||config.synthetic.password.length<32)throw Error('EXTERNAL_MONITOR_SYNTHETIC_CONFIGURATION_REQUIRED');
 return config;
}

async function boundedJson(response:Response){
 if(!response.body)throw Error('EMPTY_RESPONSE');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)throw Error('RESPONSE_TOO_LARGE');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}

export async function probe(config:ProbeConfig,options:{fetch?:typeof fetch;now?:()=>number;timeoutMs?:number}={}):Promise<Observation>{
 validateProbeConfig(config);
 const request=options.fetch??fetch,now=options.now??Date.now,started=now(),checks:Check[]=[];
 const origin=config.environment==='production'?'https://porchday.org':'https://staging.porchday.com';
 const statusOrigin=config.environment==='production'?'https://status.porchday.com':'https://staging-status.porchday.com';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??10000);
 async function json(url:string,init:RequestInit={}){
  const r=await request(url,{...init,redirect:'manual',signal:controller.signal});
  if(r.status>=300&&r.status<400){await r.body?.cancel();throw Error('REDIRECT_REJECTED');}
  return {response:r,value:await boundedJson(r)};
 }
 const safe=async(name:string,work:()=>Promise<{ok:boolean;status?:number}>)=>{
  const checkStarted=now();
  try{checks.push({name,...await work(),durationMs:Math.max(0,Math.round(now()-checkStarted))});}
  catch{checks.push({name,ok:false,durationMs:Math.max(0,Math.round(now()-checkStarted)),failure:controller.signal.aborted?'deadline':'transport_or_response'});}
 };
 let cookie:string|undefined;
 try{
  await Promise.all([
   safe('protected_readiness',async()=>{
    const {response:r,value:j}=await json(origin+'/api/operations/health',{headers:{Authorization:'Bearer '+config.healthToken}});
    return{status:r.status,ok:r.status===200&&j?.status==='ok'&&Array.isArray(j.issues)&&j.issues.length===0};
   }),
   safe('anonymous_session',async()=>{const {response:r,value:j}=await json(origin+'/api/auth/get-session');return{status:r.status,ok:r.status===200&&j===null};}),
   ...(config.environment==='production'?[safe('legacy_anonymous_session',async()=>{const {response:r,value:j}=await json('https://porchday.com/api/auth/get-session');return{status:r.status,ok:r.status===200&&j===null};})]:[]),
   safe('monitor_freshness',async()=>{
    const {response:r,value:j}=await json(statusOrigin+'/status'),checked=Date.parse(j?.last_checked_at);
    return{status:r.status,ok:r.status===200&&Number.isFinite(checked)&&checked>=now()-90000&&checked<=now()+30000};
   }),
   (async()=>{
    await safe('login',async()=>{
     const {response:r,value:j}=await json(origin+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:config.synthetic.email,password:config.synthetic.password})});
     if(r.status!==200||j?.user?.id!==config.synthetic.id)return{status:r.status,ok:false};
     const cookies=r.headers.getSetCookie().filter(value=>/^__Secure-[^=]*session_token=|^[^=;]*session_token=/.test(value));
     if(cookies.length!==1)return{status:r.status,ok:false};
     cookie=cookies[0].split(';',1)[0];
     return{status:r.status,ok:true};
    });
    if(!cookie){for(const name of ['authorized_profile','authorized_feed','logout','revocation'])checks.push({name,ok:false,failure:'dependency'});return;}
    await Promise.all([
     safe('authorized_profile',async()=>{const {response:r,value:j}=await json(origin+'/api/v1/me?bootstrap=1',{headers:{Cookie:cookie!}});return{status:r.status,ok:r.status===200&&j?.id===config.synthetic.id&&!!r.headers.get('cache-control')?.includes('no-store')};}),
     safe('authorized_feed',async()=>{const {response:r,value:j}=await json(origin+'/api/v1/feed?limit=1',{headers:{Cookie:cookie!}});return{status:r.status,ok:r.status===200&&Array.isArray(j?.items)&&j.items.length===0&&!!r.headers.get('cache-control')?.includes('no-store')};}),
    ]);
    // One logout only. Never replay an ambiguous write or print its response.
    await safe('logout',async()=>{const {response:r}=await json(origin+'/api/auth/sign-out',{method:'POST',headers:{Cookie:cookie!,Origin:origin,'Content-Type':'application/json'},body:'{}'});return{status:r.status,ok:r.status===200};});
    await safe('revocation',async()=>{const {response:r}=await json(origin+'/api/v1/me?bootstrap=1',{headers:{Cookie:cookie!}});return{status:r.status,ok:r.status===401};});
   })(),
  ]);
 }finally{clearTimeout(timer);cookie=undefined;}
 checks.sort((a,b)=>a.name.localeCompare(b.name));
 return{v:1,at:new Date(started).toISOString(),environment:config.environment,healthy:checks.every(check=>check.ok),checks,
  durationMs:Math.max(0,Math.round(now()-started)),scope:'login_authorized_reads_logout_and_readiness'};
}
