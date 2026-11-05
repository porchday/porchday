import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,realpathSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runReleaseJourney} from './release-journey.ts';
import {createReleaseVerifier} from './release-verification.ts';
import {createHash} from 'node:crypto';
import type {DeploymentPlan} from './deployment-recovery.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';
const plan:DeploymentPlan={operationId:id(1),worker:'porchday-staging',candidateVersion:id(2),candidateSource:'a'.repeat(40),baselineVersion:id(3),baselineDeploymentId:id(4),compatibleRollbackVersions:[id(3)],evidenceDigest:'b'.repeat(64)};
function fixture(){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'porchday-journey-'))),config={environment:'staging' as const,healthToken:'h'.repeat(32),synthetic:{id:id(10),email:id(10)+'@example.test',password:'p'.repeat(32)}};
 let revoked=false;const calls:string[]=[];
 const request=vi.fn(async(input:any,init:any)=>{
  init.signal.throwIfAborted();const path=new URL(String(input)).pathname;calls.push((init.method??'GET')+' '+path);
  if(path.endsWith('/health'))return Response.json({status:'ok',issues:[]});
  if(path.endsWith('/get-session'))return Response.json(null);
  if(path.endsWith('/status'))return Response.json({last_checked_at:new Date().toISOString()});
  if(path.endsWith('/sign-in/email'))return Response.json({user:{id:config.synthetic.id}},{headers:{'set-cookie':'better-auth.session_token=private-test-token; HttpOnly'}});
  if(path.endsWith('/sign-out')){revoked=true;return Response.json({success:true});}
  if(path.endsWith('/me'))return revoked?Response.json({}, {status:401}):Response.json({id:config.synthetic.id},{headers:{'cache-control':'no-store'}});
  if(path.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'no-store'}});
  if(path.endsWith('.js'))return new Response('module',{headers:{'content-type':'text/javascript'}});
  throw Error('UNEXPECTED');
 });
 const options={plan,version:plan.candidateVersion,config,directory,assertLease:vi.fn(()=>{}),fetch:request as typeof fetch};
 return{directory,config,calls,request,options,revoke:()=>{revoked=true;},journal:()=>join(directory,readdirSync(directory)[0]),run:()=>runReleaseJourney(options,AbortSignal.timeout(5000)),close:()=>rmSync(directory,{recursive:true,force:true})};
}
describe('durable authenticated release journey',()=>{
 it('replays only retained authenticated results, refreshes safe reads and deletes the revoked cookie',async()=>{const f=fixture();try{
  const first=await f.run();expect(first.status).toBe('healthy');expect(await f.run()).toMatchObject({status:'healthy'});
  expect(f.calls.filter(x=>x.startsWith('POST'))).toEqual(['POST /api/auth/sign-in/email','POST /api/auth/sign-out']);expect(readdirSync(f.journal())).not.toContain('session.json');
  expect(f.calls.filter(x=>x==='GET /api/operations/health')).toHaveLength(2);for(const secret of ['private-test-token',f.config.healthToken,f.config.synthetic.password,f.config.synthetic.id])expect(JSON.stringify(first)).not.toContain(secret);
 }finally{f.close();}});
 it('never retries a login whose reply was lost',async()=>{const f=fixture();try{
  const base=f.request.getMockImplementation()!;f.request.mockImplementation(async(input,init)=>{if(String(input).endsWith('/sign-in/email')){f.calls.push('POST /api/auth/sign-in/email');throw Error('LOST_REPLY');}return base(input,init);});
  expect(await f.run()).toMatchObject({status:'unknown',unresolved:'login'});expect(await f.run()).toMatchObject({status:'unknown',unresolved:'login'});expect(f.calls.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 }finally{f.close();}});
 it('reconciles lost logout acknowledgement by observed revocation without inventing an HTTP 200 reply',async()=>{const f=fixture();try{
  const base=f.request.getMockImplementation()!;f.request.mockImplementation(async(input,init)=>{const result=await base(input,init);if(String(input).endsWith('/sign-out'))throw Error('LOST_REPLY');return result;});
  const result=await f.run();expect(result).toMatchObject({status:'healthy',logoutReconciled:true});expect(result.checks.find(c=>c.name==='logout')).toEqual({name:'logout',ok:true});await f.run();expect(f.calls.filter(x=>x.includes('/sign-out'))).toHaveLength(1);
 }finally{f.close();}});
 it('retains the cookie for pending logout and resumes with read-only revocation checks',async()=>{const f=fixture();try{
  const base=f.request.getMockImplementation()!;f.request.mockImplementation(async(input,init)=>{if(String(input).endsWith('/sign-out')){f.calls.push('POST /api/auth/sign-out');throw Error('UNKNOWN');}return base(input,init);});
  expect(await f.run()).toMatchObject({status:'unknown',unresolved:'logout'});expect(readdirSync(f.journal())).toContain('session.json');
  f.revoke();expect(await f.run()).toMatchObject({status:'healthy',logoutReconciled:true});expect(f.calls.filter(x=>x.startsWith('POST'))).toHaveLength(2);expect(readdirSync(f.journal())).not.toContain('session.json');
 }finally{f.close();}});
 it('rejects changed configuration and malformed saved read evidence before any new POST',async()=>{const f=fixture();try{
  await f.run();const posts=f.calls.filter(x=>x.startsWith('POST')).length;
  f.options.config={...f.config,healthToken:'x'.repeat(32)};await expect(f.run()).rejects.toThrow('SCOPE_CHANGED');f.options.config=f.config;
  const path=join(f.journal(),'reads.json'),record=JSON.parse(readFileSync(path,'utf8'));record.data=[];writeFileSync(path,JSON.stringify(record));await expect(f.run()).rejects.toThrow('RECORD_INVALID');expect(f.calls.filter(x=>x.startsWith('POST'))).toHaveLength(posts);
 }finally{f.close();}});
 it('resumes after saved login without issuing another login',async()=>{const f=fixture();try{
  const base=f.request.getMockImplementation()!;let stop=true;f.options.assertLease=()=>{if(stop&&readdirSync(f.directory).length&&readdirSync(f.journal()).includes('session.json'))throw Error('INTERRUPTED');};
  await expect(f.run()).rejects.toThrow('INTERRUPTED');stop=false;expect(await f.run()).toMatchObject({status:'healthy'});expect(f.calls.filter(x=>x.includes('/sign-in/email'))).toHaveLength(1);
 }finally{f.close();}});
 it('integrates with release asset verification and a new verifier instance without another user write',async()=>{const f=fixture();try{
  const digest=createHash('sha256').update('module').digest('hex'),assets={candidate:{source:'a'.repeat(40),files:{'asset.js':digest}},baseline:{source:'c'.repeat(40),files:{'asset.js':digest}}};
  const options={plan,config:f.config,assets,directory:join(f.directory,'proofs'),journey:{directory:f.directory,assertLease:f.options.assertLease},fetch:f.options.fetch};
  expect(await createReleaseVerifier(options)(plan.candidateVersion,AbortSignal.timeout(5000))).toBe('healthy');expect(await createReleaseVerifier(options)(plan.candidateVersion,AbortSignal.timeout(5000))).toBe('healthy');expect(f.calls.filter(x=>x.startsWith('POST'))).toHaveLength(2);
 }finally{f.close();}});
});

it('resumes a real SIGKILL after the durable logout intent using GETs only',async()=>{
 const f=fixture(),moduleUrl=new URL('./release-journey.ts',import.meta.url).href;
 const program=`import {runReleaseJourney} from ${JSON.stringify(moduleUrl)};
 const plan=JSON.parse(process.argv[2]),config=JSON.parse(process.argv[3]);
 await runReleaseJourney({plan,version:plan.candidateVersion,config,directory:process.argv[1],assertLease:()=>{},fetch:async(input,init)=>{
  const p=new URL(String(input)).pathname;
  if(p.endsWith('/sign-out')){process.stdout.write('LOGOUT_INTENT_DURABLE\\n');await new Promise(()=>{setInterval(()=>{},1000);});}
  if(p.endsWith('/health'))return Response.json({status:'ok',issues:[]});
  if(p.endsWith('/get-session'))return Response.json(null);
  if(p.endsWith('/status'))return Response.json({last_checked_at:new Date().toISOString()});
  if(p.endsWith('/sign-in/email'))return Response.json({user:{id:config.synthetic.id}},{headers:{'set-cookie':'better-auth.session_token=private-test-token; HttpOnly'}});
  if(p.endsWith('/me'))return Response.json({id:config.synthetic.id},{headers:{'cache-control':'no-store'}});
  if(p.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'no-store'}});
  throw Error('UNEXPECTED');
 }},new AbortController().signal);`;
 const child=spawn(process.execPath,['--input-type=module','-e',program,f.directory,JSON.stringify(plan),JSON.stringify(f.config)],{stdio:['ignore','pipe','pipe']});
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child startup timeout')),5000);child.stdout!.once('data',chunk=>{clearTimeout(timer);String(chunk).includes('LOGOUT_INTENT_DURABLE')?resolve():reject(Error('unexpected output'));});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(Error('early child exit'));});});
  const ended=once(child,'exit');child.kill('SIGKILL');await ended;
  expect(readdirSync(f.journal())).toContain('session.json');f.revoke();expect(await f.run()).toMatchObject({status:'healthy',logoutReconciled:true,authenticatedChecksReused:true});
  expect(f.calls.every(call=>call.startsWith('GET'))).toBe(true);expect(readdirSync(f.journal())).not.toContain('session.json');
 }finally{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}f.close();}
});

it('requires the lease before creating journal files or sending requests',async()=>{const f=fixture();try{
 f.options.assertLease=()=>{throw Error('LEASE_LOST');};await expect(f.run()).rejects.toThrow('LEASE_LOST');expect(readdirSync(f.directory)).toEqual([]);expect(f.calls).toEqual([]);
}finally{f.close();}});
