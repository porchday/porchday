import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReleaseVerifier} from './release-verification.ts';
import {recoverDeployment,type DeploymentPlan,type DeploymentObservation} from './deployment-recovery.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {FileDeploymentLease,leasedDeploymentPorts} from './deployment-recovery-lease.ts';
import {publicAssetManifestHash} from './release-assets-verify.ts';
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
 it.each(['api-complete','api-rollback','frontend-complete','frontend-rollback','hidden-api-complete'])('records the verified asset package and resumes finalization for %s',async scenario=>{
  const f=fixture(),frontend=scenario.startsWith('frontend'),rollback=scenario.endsWith('rollback'),hidden=scenario.startsWith('hidden');
  const release:DeploymentPlan={...plan,worker:frontend?'porchday-staging-edge':plan.worker,...(frontend?{backendVersion:uuid(20),backendReaderFloor:uuid(21)}:{}),assetManifests:{candidate:publicAssetManifestHash(f.options.assets.candidate),baseline:publicAssetManifestHash(f.options.assets.baseline)}};
  const before={stagingVersion:frontend?uuid(20):plan.baselineVersion,stagingRuntimeSource:'c'.repeat(40),stagingAssetsSource:'d'.repeat(40),compatibleRollbackVersions:{staging:frontend?uuid(21):plan.baselineVersion},edgeRouting:{stagingEnabled:frontend||hidden,stagingFrontendVersion:plan.baselineVersion,stagingFrontendSource:'e'.repeat(40)},sourceComposition:'keep'};
  const canonical=join(f.root,'latest-verified-deployment.json');writeFileSync(canonical,JSON.stringify(before),{mode:0o600});
  if(hidden){expect(()=>FileDeploymentLease.acquire(f.root,release)).toThrow('ASSETS_NOT_PUBLIC_TARGET');expect(existsSync(join(f.root,'deployment-lock'))).toBe(false);expect(f.calls).toEqual([]);expect(JSON.parse(readFileSync(canonical,'utf8'))).toEqual(before);return;}
  const journal=new FileRecoveryJournal(join(f.root,'journal'));let current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null},lease=FileDeploymentLease.acquire(f.root,release),writes=0;
  try{
   const verify=createReleaseVerifier({...f.options,plan:release,fetch:async(input,init)=>rollback&&current.version===plan.candidateVersion&&String(input).endsWith('/health')?Response.json({status:'unavailable',issues:[]},{status:503}):f.transport(input,init)});
   const ports=leasedDeploymentPorts(release,lease,journal,{authorize:async()=>{},observe:async()=>({...current}),deploy:async(version,operationId)=>{writes++;current={version,operationId,deploymentId:uuid(30+writes)};},verify});
   expect(await recoverDeployment(release,journal,ports)).toBe(rollback?'rolled-back':'complete');expect(writes).toBe(rollback?2:1);
   const key=frontend?'staging-edge':'staging',version=rollback?plan.baselineVersion:plan.candidateVersion,proof=verify.assetProof(version)!;expect(proof).toBeTruthy();
   const snapshot=join(f.root,'snapshot.json');writeFileSync(snapshot,JSON.stringify({workers:{staging:{active:before.stagingVersion},[key]:{active:version}}}),{mode:0o600});
   await expect(lease.finalize(journal,snapshot)).rejects.toThrow('ASSET_PROOF_REQUIRED');expect(JSON.parse(readFileSync(canonical,'utf8'))).toEqual(before);
   const original=readFileSync(proof,'utf8');
   for(const tamper of ['checks','version','manifest']){
    const invalid=JSON.parse(original);if(tamper==='checks')invalid.detail.report.checks=[];else if(tamper==='version')invalid.version=uuid(999);else invalid.detail.manifest.source='f'.repeat(40);
    writeFileSync(proof,JSON.stringify(invalid));await expect(lease.finalize(journal,snapshot,proof)).rejects.toThrow('ASSET_PROOF_INVALID');
   }
   writeFileSync(proof,original);
   await lease.finalize(journal,snapshot,proof);lease.close();
   writeFileSync(proof,original+' ');expect(()=>FileDeploymentLease.acquire(f.root,release)).toThrow('ASSET_PROOF_CHANGED');writeFileSync(proof,original);
   lease=FileDeploymentLease.acquire(f.root,release);await lease.finalize(journal);await lease.release(journal);
   const result=await FileDeploymentLease.completed(f.root,release,journal),manifest=rollback?f.options.assets.baseline:f.options.assets.candidate;
   expect(result?.stagingAssetsSource).toBe(manifest.source);expect(result?.sourceComposition).toBe('keep');
   expect(result?.releaseAssets).toMatchObject({[key]:{version,source:manifest.source,manifestSha256:publicAssetManifestHash(manifest)}});
   if(frontend){expect(result?.stagingVersion).toBe(before.stagingVersion);expect(result?.stagingRuntimeSource).toBe(before.stagingRuntimeSource);expect(result?.edgeRouting).toMatchObject({stagingFrontendAssetsSource:manifest.source});}
  }finally{lease.close();}
 });
 it('rejects manifests that differ from the immutable asset plan before a journey starts',()=>{
  const f=fixture(),release={...plan,assetManifests:{candidate:'f'.repeat(64),baseline:publicAssetManifestHash(f.options.assets.baseline)}};
  expect(()=>createReleaseVerifier({...f.options,plan:release})).toThrow('ASSET_PLAN_MISMATCH');expect(f.calls).toEqual([]);
 });
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
