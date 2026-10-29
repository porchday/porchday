import {constants,closeSync,fsyncSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {deploymentPlanHash,recoveryTarget,type DeploymentPlan} from './deployment-recovery.ts';
import {validateProbeConfig,type ProbeConfig,type Check} from './external-monitor-probe.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Result={at:string;status:'healthy'|'unhealthy'|'unknown';checks:Check[];unresolved?:'login'|'logout';logoutReconciled?:boolean;authenticatedAt?:string;authenticatedChecksReused?:boolean};
function privateDirectory(path:string){const s=lstatSync(path);if(!isAbsolute(path)||realpathSync(path)!==path||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('RELEASE_JOURNEY_DIRECTORY_INVALID');}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
class Journal{
 readonly directory:string;readonly scope:string;
 constructor(directory:string,scope:string){this.directory=directory;this.scope=scope;privateDirectory(directory);}
 read<T>(name:string):T|null{
  const path=join(this.directory,name+'.json');if(!existsSync(path))return null;
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
   const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>65536)throw Error('RELEASE_JOURNEY_RECORD_INVALID');
   const value=JSON.parse(readFileSync(fd,'utf8'));if(value.v!==1||value.scope!==this.scope||Object.keys(value).sort().join(',')!=='data,scope,v')throw Error('RELEASE_JOURNEY_SCOPE_CHANGED');return value.data as T;
  }finally{closeSync(fd);}
 }
 write(name:string,data:unknown){
  privateDirectory(this.directory);const bytes=JSON.stringify({v:1,scope:this.scope,data})+'\n';if(Buffer.byteLength(bytes)>65536)throw Error('RELEASE_JOURNEY_RECORD_TOO_LARGE');
  const path=join(this.directory,name+'.json'),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}sync(this.directory);
 }
 removeSession(){if(existsSync(join(this.directory,'session.json'))){this.read('session');unlinkSync(join(this.directory,'session.json'));sync(this.directory);}}
}
async function json(response:Response){
 if(!response.body)throw Error('RELEASE_JOURNEY_RESPONSE_INVALID');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>16384)throw Error('RELEASE_JOURNEY_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString());
}
/** Call only under the deployment lease. assertLease runs at each I/O boundary.
 * A login/logout intent is durable before its one POST. Unknown login stays unknown;
 * unknown logout is reconciled solely by reading the saved session's revocation.
 */
export async function runReleaseJourney(options:{plan:DeploymentPlan;version:string;config:ProbeConfig;directory:string;assertLease:(signal:AbortSignal)=>void;fetch?:typeof fetch},signal:AbortSignal):Promise<Result>{
 const plan=structuredClone(options.plan),config=structuredClone(options.config),version=options.version,planHash=deploymentPlanHash(plan);validateProbeConfig(config);
 if(![plan.candidateVersion,plan.baselineVersion].includes(version)||recoveryTarget(plan.worker).environment!==config.environment)throw Error('RELEASE_JOURNEY_SCOPE_CHANGED');
 signal.throwIfAborted();options.assertLease(signal);privateDirectory(options.directory);const directory=join(options.directory,planHash+'-'+version);
 try{mkdirSync(directory,{mode:0o700});sync(options.directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const scope=hash(JSON.stringify({planHash,version,config})),journal=new Journal(directory,scope),assert=()=>{signal.throwIfAborted();options.assertLease(signal);privateDirectory(directory);};
 assert();if(!journal.read('scope'))journal.write('scope',{planHash,version});
 const checks:Check[]=[],at=new Date().toISOString(),origin=config.environment==='production'?'https://porchday.org':'https://staging.porchday.com',transport=options.fetch??fetch;
 const request=async(path:string,init:RequestInit={})=>{assert();const response=await transport(path.startsWith('https:')?path:origin+path,{...init,redirect:'error',signal});assert();return response;};
 const readCheck=async(name:string,path:string,test:(r:Response,j:any)=>boolean,headers:Record<string,string>={})=>{
  try{const response=await request(path,{headers}),body=await json(response);assert();return{name,ok:test(response,body),status:response.status} satisfies Check;}
  catch{return{name,ok:false,failure:'transport_or_response'} satisfies Check;}
 };
 const fresh=await Promise.all([
  readCheck('protected_readiness','/api/operations/health',(r,j)=>r.status===200&&j?.status==='ok'&&Array.isArray(j.issues)&&j.issues.length===0,{Authorization:'Bearer '+config.healthToken}),
  readCheck('anonymous_session','/api/auth/get-session',(r,j)=>r.status===200&&j===null),
  readCheck('monitor_freshness',config.environment==='production'?'https://status.porchday.com/status':'https://staging-status.porchday.com/status',(r,j)=>{const t=Date.parse(j?.last_checked_at);return r.status===200&&Number.isFinite(t)&&t>=Date.now()-90000&&t<=Date.now()+30000;}),
  ...(config.environment==='production'?[readCheck('legacy_anonymous_session','https://porchday.com/api/auth/get-session',(r,j)=>r.status===200&&j===null)]:[]),
 ]);checks.push(...fresh);assert();
 const revoked=journal.read<{status:number}>('revocation'),reads=journal.read<Check[]>('reads'),reply=journal.read<{status:number}>('logout-reply');
 let loginIntent=journal.read<{attempt:number;at:string}>('login-intent');const logoutIntent=journal.read<{attempt:number;at:string}>('logout-intent');
 for(const intent of [loginIntent,logoutIntent])if(intent&&(Object.keys(intent).sort().join(',')!=='at,attempt'||intent.attempt!==1||typeof intent.at!=='string'||!Number.isFinite(Date.parse(intent.at))))throw Error('RELEASE_JOURNEY_RECORD_INVALID');
 if(reply&&(Object.keys(reply).join(',')!=='status'||!Number.isInteger(reply.status)||reply.status<100||reply.status>599))throw Error('RELEASE_JOURNEY_RECORD_INVALID');
 if(reads&&(!Array.isArray(reads)||reads.length!==2||reads.map(c=>c.name).sort().join(',')!=='authorized_feed,authorized_profile'||reads.some(c=>typeof c.ok!=='boolean'||Object.keys(c).some(k=>!['name','ok','status','failure'].includes(k))||c.ok&&c.status!==200||c.status!==undefined&&(!Number.isInteger(c.status)||c.status<100||c.status>599))))throw Error('RELEASE_JOURNEY_RECORD_INVALID');
 if((reads||logoutIntent||reply||revoked)&&!loginIntent||reply&&!logoutIntent||logoutIntent&&!reads)throw Error('RELEASE_JOURNEY_RECORD_INVALID');
 if(revoked){
  if(Object.keys(revoked).join(',')!=='status'||revoked.status!==401||!reads||!journal.read('logout-intent')||!journal.read('login-intent'))throw Error('RELEASE_JOURNEY_RECORD_INVALID');
  journal.removeSession();checks.push({name:'login',ok:true},...reads,{name:'logout',ok:!reply||reply.status===200,...(reply?{status:reply.status}:{})},{name:'revocation',ok:true,status:401});
  return{at,status:checks.every(c=>c.ok)?'healthy':'unhealthy',checks,logoutReconciled:!reply,authenticatedAt:loginIntent!.at,authenticatedChecksReused:true};
 }
 let session=journal.read<{cookie:string}>('session');
 if(session&&!loginIntent)throw Error('RELEASE_JOURNEY_RECORD_INVALID');
 if(!session){
  if(reads||logoutIntent||reply)throw Error('RELEASE_JOURNEY_RECORD_INVALID');
  if(journal.read('login-intent'))return{at,status:'unknown',checks,unresolved:'login'};
  assert();loginIntent={attempt:1,at:new Date().toISOString()};journal.write('login-intent',loginIntent);
  try{
   const r=await request('/api/auth/sign-in/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:config.synthetic.email,password:config.synthetic.password})}),body=await json(r);assert();
   if(r.status!==200||body?.user?.id!==config.synthetic.id)throw Error('LOGIN_UNCONFIRMED');
   const cookies=r.headers.getSetCookie().filter(x=>/^__Secure-[^=]*session_token=|^[^=;]*session_token=/.test(x));if(cookies.length!==1)throw Error('LOGIN_UNCONFIRMED');
   session={cookie:cookies[0].split(';',1)[0]};journal.write('session',session);
  }catch{return{at,status:'unknown',checks,unresolved:'login'};}
 }
 if(typeof session.cookie!=='string'||session.cookie.length<1||session.cookie.length>8192||/[\r\n]/.test(session.cookie))throw Error('RELEASE_JOURNEY_SESSION_INVALID');
 checks.push({name:'login',ok:true});
 let authorized=reads;
 if(!authorized){
  if(journal.read('logout-intent'))throw Error('RELEASE_JOURNEY_RECORD_INVALID');
  authorized=await Promise.all([
   readCheck('authorized_profile','/api/v1/me?bootstrap=1',(r,j)=>r.status===200&&j?.id===config.synthetic.id&&!!r.headers.get('cache-control')?.includes('no-store'),{Cookie:session.cookie}),
   readCheck('authorized_feed','/api/v1/feed?limit=1',(r,j)=>r.status===200&&Array.isArray(j?.items)&&j.items.length===0&&!!r.headers.get('cache-control')?.includes('no-store'),{Cookie:session.cookie}),
  ]);assert();journal.write('reads',authorized);
 }
 checks.push(...authorized);
 if(!journal.read('logout-intent')){
  assert();journal.write('logout-intent',{attempt:1,at:new Date().toISOString()});
  try{const r=await request('/api/auth/sign-out',{method:'POST',headers:{Cookie:session.cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});await json(r);assert();journal.write('logout-reply',{status:r.status});}catch{/* Reconcile only by reading revocation; never repeat POST. */}
 }
 const logout=journal.read<{status:number}>('logout-reply');
 const revocation=await readCheck('revocation','/api/v1/me?bootstrap=1',r=>r.status===401,{Cookie:session.cookie});checks.push(revocation);assert();
 if(!revocation.ok)return{at,status:'unknown',checks,unresolved:'logout',authenticatedAt:loginIntent!.at,authenticatedChecksReused:!!reads};
 journal.write('revocation',{status:401});journal.removeSession();
 checks.push({name:'logout',ok:!logout||logout.status===200,...(logout?{status:logout.status}:{})});
 return{at,status:checks.every(c=>c.ok)?'healthy':'unhealthy',checks,logoutReconciled:!logout,authenticatedAt:loginIntent!.at,authenticatedChecksReused:!!reads};
}
