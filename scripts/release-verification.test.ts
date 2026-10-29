import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {chmodSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReleaseVerifier} from './release-verification.ts';
import {recoverDeployment,type DeploymentPlan,type DeploymentObservation} from './deployment-recovery.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import type {ProbeConfig} from './external-monitor-probe.ts';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-staging',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64)};
const config:ProbeConfig={environment:'staging',healthToken:'h'.repeat(32),synthetic:{id:uuid(99),email:uuid(99)+'@example.test',password:'p'.repeat(32)}};
const roots:string[]=[];
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'porchday-release-verification-'));roots.push(root);let revoked=false;const calls:string[]=[];
 const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
 const transport:typeof fetch=async(input,init)=>{
  init?.signal?.throwIfAborted();const url=String(input);calls.push(url);
  if(url.includes('/assets/'))return new Response('module',{headers:{'content-type':'text/javascript'}});
  if(url.endsWith('/health'))return json({status:'ok',issues:[]});
  if(url.endsWith('/get-session'))return json(null);
  if(url.endsWith('/status'))return json({last_checked_at:new Date().toISOString()});
  if(url.endsWith('/sign-in/email')){revoked=false;return json({user:{id:config.synthetic.id}},200,{'set-cookie':'better-auth.session_token=test-token; HttpOnly'});}
  if(url.includes('/me?'))return revoked?json({},401):json({id:config.synthetic.id},200,{'cache-control':'no-store'});
  if(url.includes('/feed?'))return json({items:[]},200,{'cache-control':'no-store'});
  if(url.endsWith('/sign-out')){revoked=true;return json({success:true});}
  throw Error('UNEXPECTED');
 };
 const assets={candidate:{source:plan.candidateSource,files:{'assets/current.js':sha('module')}},baseline:{source:'c'.repeat(40),files:{'assets/old.js':sha('module')}}};
 const directory=join(root,'evidence'),options={plan,config,assets,directory,fetch:transport};
 const records=()=>readdirSync(directory).map(file=>JSON.parse(readFileSync(join(directory,file),'utf8')));
 return{root,options,calls,records,transport};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('shared release journey and asset gate',()=>{
 it('rejects overlapping journeys against the same verifier identity',async()=>{
  const f=fixture();let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve;});const fetcher:typeof fetch=async(input,init)=>{await gate;return f.transport(input,init);};
  const verify=createReleaseVerifier({...f.options,fetch:fetcher}),first=verify(plan.candidateVersion,new AbortController().signal);
  await expect(verify(plan.candidateVersion,new AbortController().signal)).rejects.toThrow('ALREADY_RUNNING');unblock();expect(await first).toBe('healthy');expect(f.calls.filter(url=>url.endsWith('/sign-in/email'))).toHaveLength(1);
 });
 it('verifies public assets independently of a retained frontend executable source',async()=>{
  const f=fixture(),frontend={...plan,worker:'porchday-staging-edge',candidateSource:'f'.repeat(40),backendVersion:uuid(20),backendReaderFloor:uuid(21)};
  expect(await createReleaseVerifier({...f.options,plan:frontend})(plan.candidateVersion,new AbortController().signal)).toBe('healthy');
 });
 it('requires both checks, retains sanitized evidence and snapshots its input contract',async()=>{
  const f=fixture(),options=structuredClone({...f.options,fetch:undefined}),verify=createReleaseVerifier({...options,fetch:f.transport});options.assets.candidate.files['assets/current.js']='f'.repeat(64);
  expect(await verify(plan.candidateVersion,new AbortController().signal)).toBe('healthy');
  expect(f.records().map(r=>r.kind).sort()).toEqual(['assets','journey','outcome','started']);
  const text=JSON.stringify(f.records());for(const secret of [config.healthToken,config.synthetic.id,config.synthetic.email,config.synthetic.password,'test-token'])expect(text).not.toContain(secret);
 });
 it('retries only asset reads during convergence, never the completed journey',async()=>{
  const f=fixture();let attempts=0;const fetcher:typeof fetch=async(input,init)=>String(input).includes('/assets/')&&++attempts===1?new Response('<html>',{headers:{'content-type':'text/html'}}):f.transport(input,init);
  expect(await createReleaseVerifier({...f.options,fetch:fetcher})(plan.candidateVersion,new AbortController().signal)).toBe('healthy');
  expect(attempts).toBe(2);expect(f.calls.filter(url=>url.endsWith('/sign-out'))).toHaveLength(1);
  expect(f.records().filter(r=>r.kind==='assets').map(r=>r.detail.report.healthy).sort()).toEqual([false,true]);
 });
 it('feeds persistent HTTP-200 wrong assets into the actual rollback controller',async()=>{
  const f=fixture();let current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};const writes:string[]=[],authorizations:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>String(input).includes('/assets/')&&current.version===plan.candidateVersion?new Response('<html>',{headers:{'content-type':'text/html'}}):f.transport(input,init);
  const result=await recoverDeployment(plan,new FileRecoveryJournal(join(f.root,'journal')),{authorize:async(_plan,direction)=>{authorizations.push(direction);},observe:async()=>({...current}),deploy:async(version,operationId)=>{writes.push(version);current={version,operationId,deploymentId:uuid(10+writes.length)};},verify:createReleaseVerifier({...f.options,fetch:fetcher})});
  expect(result).toBe('rolled-back');expect(writes).toEqual([plan.candidateVersion,plan.baselineVersion]);expect(authorizations).toEqual(['activate','rollback']);
  expect(f.records().filter(r=>r.kind==='assets')).toHaveLength(4);expect(f.calls.filter(url=>url.endsWith('/sign-out'))).toHaveLength(2);
 });
 it('treats a completed failed journey as unhealthy without retrying an ambiguous logout',async()=>{
  const f=fixture();let logouts=0;const fetcher:typeof fetch=async(input,init)=>{if(String(input).endsWith('/sign-out')){logouts++;throw Error('uncertain private reply');}return f.transport(input,init);};
  expect(await createReleaseVerifier({...f.options,fetch:fetcher})(plan.candidateVersion,new AbortController().signal)).toBe('unhealthy');expect(logouts).toBe(1);expect(f.records().some(r=>r.kind==='assets')).toBe(false);expect(JSON.stringify(f.records())).not.toContain('private reply');
 });
 it('keeps cancellation unknown and prevents network work without durable evidence',async()=>{
  const f=fixture(),controller=new AbortController(),verify=createReleaseVerifier(f.options);controller.abort();
  expect(await verify(plan.candidateVersion,controller.signal)).toBe('unknown');expect(f.calls).toEqual([]);
  chmodSync(f.options.directory,0o755);await expect(verify(plan.candidateVersion,new AbortController().signal)).rejects.toThrow('EVIDENCE_DIRECTORY');expect(f.calls).toEqual([]);
 });
 it('rejects cross-environment, invalid-manifest and unplanned version checks',async()=>{
  const f=fixture();expect(()=>createReleaseVerifier({...f.options,config:{...config,environment:'production'}})).toThrow('SCOPE_MISMATCH');
  const bad=structuredClone(f.options.assets);bad.candidate.source='invalid';expect(()=>createReleaseVerifier({...f.options,assets:bad})).toThrow('INVALID_PUBLIC_MANIFEST');
  await expect(createReleaseVerifier(f.options)(uuid(999),new AbortController().signal)).rejects.toThrow('VERSION_NOT_IN_PLAN');expect(f.calls).toEqual([]);
 });
});
