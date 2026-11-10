import {linkResponse,parseClientCause,clearClientCauses,clientParent} from './causal-links';
/** Explicit per-account/per-device recordings. No request bodies or arbitrary input capture. */
export type DiagnosticMode='details'|'content';
export type DiagnosticSession={id:string;mode:DiagnosticMode;started_at:number;expires_at:number};
export type DiagnosticEvent={id:string;at:number;kind:'operation'|'request'|'error'|'navigation'|'interaction'|'content';payload:Record<string,string|number|boolean>};
type Queued=DiagnosticEvent&{member:string;session:string;expires:number};
const DB='porchday-diagnostics-v1';
let owner:{member:string;device:string}|null=null,session:DiagnosticSession|null=null;
let originalFetch:typeof fetch|null=null,timer:ReturnType<typeof setInterval>|null=null,busy=false,stopped=false;
let lastRoute='',lastSnapshot='',lastCapture=0,retryAt=0,failures=0;
const sessionKey=()=>owner?`porchday-diagnostics:${owner.member}:${owner.device}`:'';
const notify=()=>window.dispatchEvent(new Event('porchday:diagnostics'));
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('events',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function queued():Promise<Queued[]>{const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('events').objectStore('events').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}}
async function changeQueue(add:Queued|undefined,ids:string[]=[]){const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('events','readwrite'),s=tx.objectStore('events');for(const id of ids)s.delete(id);if(add)s.put(add);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
let writes=Promise.resolve();
export function diagnosticStatus(){return session&&session.expires_at>Date.now()?session:null;}
export function safeDiagnosticError(error:unknown){
 const e=error as {name?:unknown;code?:unknown;status?:unknown;stack?:unknown};
 const message=error instanceof Error?error.message:'';
 const classified=/has not set up encryption|pending.*key/i.test(message)?'RECIPIENT_KEYS_PENDING':/decrypt|private key|recipient/i.test(message)?'DECRYPTION_FAILED':/identity|signature|author.*match/i.test(message)?'IDENTITY_VALIDATION_FAILED':/too large|quota|allowance/i.test(message)?'MEDIA_LIMIT':/expired|deadline/i.test(message)?'EXPIRED':/unavailable/i.test(message)?'UNAVAILABLE':undefined;
 return {...(classified?{code:classified}:{}),error:typeof e?.name==='string'&&/^[A-Za-z]{1,40}$/.test(e.name)?e.name:'Error',
  ...(typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?{code:e.code}:{}),
  ...(typeof e?.status==='number'?{status:e.status}:{}),
  // Keep only application frame coordinates, never the exception message or URL parameters.
  stack:typeof e?.stack==='string'?(e.stack.match(/\/assets\/[A-Za-z0-9_.-]+\.js:\d+:\d+/g)||[]).slice(0,12).join('\n'):''};
}
export function recordDiagnostic(kind:DiagnosticEvent['kind'],payload:DiagnosticEvent['payload']){
 const current=session,account=owner;
 if(!current||!account||stopped||current.expires_at<=Date.now()||kind==='content'&&current.mode!=='content')return;
 const event:Queued={id:crypto.randomUUID(),at:Date.now(),kind,payload,member:account.member,session:current.id,expires:current.expires_at};
 if(JSON.stringify(event).length>32000)return;
 writes=writes.then(async()=>{
  if(session?.id!==current.id||owner?.member!==account.member||stopped)return;
  const rows=await queued(),expired=rows.filter(r=>r.expires<=Date.now()).map(r=>r.id);
  const active=rows.filter(r=>r.expires>Date.now());
  // Bounded local ring; retain newest evidence if offline for an extended period.
  let bytes=active.reduce((n,r)=>n+JSON.stringify(r).length,0);
  active.sort((a,b)=>a.at-b.at);
  while(active.length>=500||bytes+JSON.stringify(event).length>2*1024*1024){const r=active.shift();if(!r)break;expired.push(r.id);bytes-=JSON.stringify(r).length;}
  await changeQueue(event,expired);
 }).catch(()=>{/* Storage failure must never interrupt the member's action. */});
}
export function diagnosticOperation(stage:string,outcome:string,error?:unknown){
 const details=error===undefined?{}:safeDiagnosticError(error);const {stack,...safe}=details as ReturnType<typeof safeDiagnosticError>;
 recordDiagnostic('operation',{operation:'access_update',stage,outcome,...safe});
 if(error!==undefined&&stack)recordDiagnostic('error',{error:safe.error??'Error',stack});
}
async function call(path:string,init:RequestInit={}){
 const send=originalFetch??fetch;const r=await send('/api/v1/diagnostics/'+path,{...init,credentials:'same-origin',headers:{'Content-Type':'application/json',...init.headers}});
 if(!r.ok)throw Error(`Diagnostics request failed (${r.status}).`);return r.json();
}
export async function startDiagnostics(mode:DiagnosticMode,contentConsent:boolean){
 const account=owner;if(!account)throw Error('Unlock your account first.');
 await stopDiagnostics();if(owner!==account)return;
 const created=await call('sessions',{method:'POST',body:JSON.stringify({device_id:account.device,mode,consent_version:1,content_consent:contentConsent})});
 if(owner!==account)return;
 session=created;stopped=false;retryAt=0;failures=0;localStorage.setItem(sessionKey(),JSON.stringify(created));lastSnapshot='';notify();
 recordDiagnostic('navigation',{route:location.pathname});
}
export async function stopDiagnostics(){
 clearClientCauses();
 const current=session;session=null;stopped=true;
 if(owner)localStorage.removeItem(sessionKey());notify();
 await writes;
 const rows=await queued().catch(()=>[]);await changeQueue(undefined,rows.filter(r=>r.session===current?.id).map(r=>r.id)).catch(()=>{});
 if(current)await call(`sessions/${current.id}/stop`,{method:'POST'}).catch(()=>{});
}
export async function deleteDiagnosticRecordings(){
 const account=owner,member=account?.member;await stopDiagnostics();
 if(owner!==account)return;
 const rows=await queued();await changeQueue(undefined,rows.filter(r=>r.member===member).map(r=>r.id));
 if(owner!==account)return;
 await call('sessions',{method:'DELETE'});
}
export async function flushDiagnostics(){
 if(Date.now()<retryAt)return;
 if(busy||!owner||!session||!navigator.onLine)return;
 if(session.expires_at<=Date.now()){await stopDiagnostics();return;}
 busy=true;const current=session,member=owner.member;
 try{
  await writes;const rows=await queued();
  const batch=rows.filter(r=>r.member===member&&r.session===current.id&&r.expires>Date.now()).sort((a,b)=>a.at-b.at).slice(0,5);
  if(!batch.length)return;
  if(session!==current||owner?.member!==member)return;
  const send=originalFetch??fetch;
  const response=await send(`/api/v1/diagnostics/sessions/${current.id}/events`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch.map(({member,session,expires,...event})=>event)}),signal:AbortSignal.timeout(15000)});
  if(response.status===410){if(session===current)await stopDiagnostics();return;}
  if(!response.ok){failures++;retryAt=Date.now()+Math.min(300000,10000*2**Math.min(failures,5));return;}
  const result=await response.json();failures=0;retryAt=0;
  await changeQueue(undefined,batch.filter(r=>Array.isArray(result.accepted)&&result.accepted.includes(r.id)).map(r=>r.id));
  if(result.full&&session===current)await stopDiagnostics();
 }catch{failures++;retryAt=Date.now()+Math.min(300000,10000*2**Math.min(failures,5));/* Keep the batch for retry. */}finally{busy=false;}
}
export function contentRoute(path:string){return path==='/'||/^\/(share|albums|wall)(\/|$)/.test(path);}
function visible(e:Element){const r=e.getBoundingClientRect();return !!(r.width&&r.height)&&r.top<innerHeight&&r.bottom>0&&!e.closest('[hidden],[data-diagnostic-private]');}
export function captureContent(){
 if(session?.mode!=='content'||!contentRoute(location.pathname)||document.visibilityState==='hidden')return;
 const root=document.querySelector('main');if(!root)return;
 // Text only from visible app content. Never inspect inputs except explicit opt-in fields.
 const text=Array.from(root.querySelectorAll('p,h1,h2,h3,figcaption')).filter(visible).map(e=>e.textContent??'').join('\n').slice(0,8000);
 const fields=Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-diagnostic-input]')).filter(e=>visible(e)&&['TEXTAREA','INPUT'].includes(e.tagName)&&!['password','hidden','email'].includes(e.type)).map(e=>({field:e.getAttribute('data-diagnostic-input'),value:e.value.slice(0,5000)}));
 const payload={text,fields:JSON.stringify(fields).slice(0,12000)},signature=JSON.stringify(payload);
 if(signature!==lastSnapshot){lastSnapshot=signature;recordDiagnostic('content',payload);}
 if(Date.now()-lastCapture<30000)return;lastCapture=Date.now();
 for(const img of Array.from(root.querySelectorAll('img')).filter(visible).filter(i=>i.naturalWidth>200&&i.naturalHeight>150).slice(0,2)){
  try{const canvas=document.createElement('canvas'),scale=Math.min(1,160/img.naturalWidth);canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);canvas.getContext('2d')?.drawImage(img,0,0,canvas.width,canvas.height);const thumbnail=canvas.toDataURL('image/jpeg',0.45);if(thumbnail.length<24000)recordDiagnostic('content',{thumbnail});}catch{/* Cross-origin images are not copied. */}
 }
}
export function attachDiagnostics(member:string,device:string){
 owner={member,device};stopped=false;
 try{const saved=JSON.parse(localStorage.getItem(sessionKey())||'null');session=saved&&saved.expires_at>Date.now()?saved:null;}catch{session=null;}
 const original=window.fetch;originalFetch=original;
 const wrapper:typeof fetch=async(input,init)=>{
  const active=session;let url:URL;try{url=new URL(input instanceof Request?input.url:String(input),location.href);}catch{return original(input,init);}
  if(!active||active.expires_at<=Date.now()||url.origin!==location.origin||!url.pathname.startsWith('/api/')||url.pathname.includes('/diagnostics/')||url.pathname.includes('/traces')||url.pathname.startsWith('/api/auth/')||url.pathname.includes('recovery'))return original(input,init);
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  const generated=crypto.randomUUID().replaceAll('-','');if(!headers.has('traceparent'))headers.set('traceparent',`00-${generated}-${generated.slice(0,16)}-01`);const trace=headers.get('traceparent')!.split('-')[1],span=headers.get('traceparent')!.split('-')[2],parent=clientParent(span);
  headers.set('X-Porchday-Diagnostic-Session',active.id);
  const started=performance.now(),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  try{const response=await original(input,{...init,headers});linkResponse(response,parseClientCause(headers.get('traceparent')));if(session===active)recordDiagnostic('request',{method,route:url.pathname,status:response.status,duration:performance.now()-started,server_timing:(response.headers.get('Server-Timing')??'').slice(0,6000),trace,span,...(parent?{parent}:{})});return response;}
  catch(error){if(session===active){const {stack,status,...safe}=safeDiagnosticError(error);recordDiagnostic('error',{...safe,stack,trace});recordDiagnostic('request',{method,route:url.pathname,status:0,duration:performance.now()-started,trace});}throw error;}
 };
 window.fetch=wrapper;
 const error=(e:ErrorEvent)=>{const {status,...safe}=safeDiagnosticError(e.error);recordDiagnostic('error',safe);};
 const rejection=(e:PromiseRejectionEvent)=>{const {status,...safe}=safeDiagnosticError(e.reason);recordDiagnostic('error',safe);};
 let inputTimer:ReturnType<typeof setTimeout>|undefined;
 const input=(e:Event)=>{const el=e.target;if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)||!contentRoute(location.pathname)||!visible(el)||!el.hasAttribute('data-diagnostic-input')||['password','hidden','email'].includes(el.type)||session?.mode!=='content')return;const active=session,value=el.value.slice(0,5000),field=el.getAttribute('data-diagnostic-input');clearTimeout(inputTimer);inputTimer=setTimeout(()=>{if(session===active)recordDiagnostic('content',{fields:JSON.stringify([{field,value}])});},500);};
 const click=(e:Event)=>{const el=e.target instanceof Element?e.target.closest('button,a,input,select,textarea'):null;if(!el||!contentRoute(location.pathname))return;const label=(el.textContent??'').trim();const known=['Share post','Add photos/videos','Add photos','Save','Cancel','Feed','Share','Albums','Connections','More'].includes(label)?label:el.tagName.toLowerCase();recordDiagnostic('interaction',{control:known,action:'click'});captureContent();};
 const tick=()=>{if(session&&session.expires_at<=Date.now()){void stopDiagnostics();return;}if(location.pathname!==lastRoute){lastRoute=location.pathname;recordDiagnostic('navigation',{route:lastRoute});}captureContent();void flushDiagnostics();};
 window.addEventListener('error',error);window.addEventListener('unhandledrejection',rejection);window.addEventListener('online',tick);document.addEventListener('click',click);document.addEventListener('input',input);document.addEventListener('visibilitychange',tick);
 timer=setInterval(tick,10000);
 const detach=()=>{clearClientCauses();clearTimeout(inputTimer);if(timer)clearInterval(timer);timer=null;window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',rejection);window.removeEventListener('online',tick);document.removeEventListener('click',click);document.removeEventListener('input',input);document.removeEventListener('visibilitychange',tick);if(window.fetch===wrapper)window.fetch=original;originalFetch=null;owner=null;session=null;stopped=true;notify();};
 notify();return detach;
}

export async function diagnosticStep<T>(stage:string,work:()=>Promise<T>):Promise<T>{diagnosticOperation(stage,'started');try{const result=await work();diagnosticOperation(stage,'succeeded');return result;}catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))diagnosticOperation(stage,'failed',error);throw error;}}
