import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {chromium,type Browser,type Route} from 'playwright';
import {beginHostedAssetTransition,hostedDocumentMatches} from './release-assets-hosted.ts';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserGate,withBrowserAcceptance} from './release-browser-gate.ts';
import {recoverDeployment,type DeploymentPlan,type DeploymentObservation,type RecoveryState} from './deployment-recovery.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const origin='https://staging.porchday.com';
const form=`document.body.innerHTML='<label for="email">Email address</label><input id="email" type="email"><input type="password">';`;
function fixture(fault:'none'|'exception'|'mime'|'old-bytes'|'shell'|'requests'='none'){
 const oldHtml='<html><body><script type="module" src="/assets/index-old.js"></script></body></html>',newHtml=oldHtml.replace('index-old','index-new');
 const oldEntry=form+'\nexport const lazy=()=>import("./Lazy-old.js");',lazy='export default function Lazy(){}';
 const newEntry=form+(fault==='exception'?'\nthrow Error("private synthetic exception");':fault==='mime'?'\nawait import("./missing.js").catch(()=>{});':fault==='requests'?'\nawait Promise.all([fetch("https://elsewhere.invalid/test").catch(()=>{}),fetch("/api/should-not-write",{method:"POST",body:"synthetic"}).catch(()=>{})]);':'');
 const files={'index.html':sha(oldHtml),'assets/index-old.js':sha(oldEntry),'assets/Lazy-old.js':sha(lazy)};
 const baseline={source:'a'.repeat(40),files},candidate={source:'b'.repeat(40),files:{...files,'index.html':sha(newHtml),'assets/index-new.js':sha(newEntry)}};
 let after=false,closed=0,allowed=0,blocked=0;
 const response=(url:string)=>{
  const path=new URL(url).pathname;
  if(path==='/login')return {body:after?(fault==='shell'?oldHtml:newHtml):oldHtml,contentType:'text/html'};
  if(path==='/assets/index-old.js')return {body:oldEntry,contentType:'text/javascript'};
  if(path==='/assets/index-new.js')return {body:newEntry,contentType:'text/javascript'};
  if(path==='/assets/Lazy-old.js')return {body:after&&fault==='old-bytes'?lazy+'/* changed */':lazy,contentType:'text/javascript'};
  return {body:newHtml,contentType:'text/html'};
 };
 const launch=async()=>{
  const browser=await chromium.launch({headless:true}),newContext=browser.newContext.bind(browser),close=browser.close.bind(browser);
  browser.close=async()=>{closed++;await close();};
  browser.newContext=async(options)=>{
   const context=await newContext(options),route=context.route.bind(context);
   // Real Chromium, synthetic transport. Exercise the observer's route decision
   // before supplying bytes; no network request leaves this test.
   context.route=async(pattern,handler)=>route(pattern,async(real:Route)=>{
    const wrapped={request:()=>real.request(),continue:async()=>{allowed++;await real.fulfill({status:200,...response(real.request().url())});},abort:async()=>{blocked++;await real.abort();}};
    await handler(wrapped as unknown as Route,real.request());
   });return context;
  };return browser as Browser;
 };
 const fetcher:typeof fetch=async(input,init)=>{expect(init?.redirect).toBe('error');const r=response(String(input));return new Response(r.body,{headers:{'content-type':r.contentType}});};
 return{baseline,candidate,launch,fetch:fetcher,switch:()=>{after=true;},counts:()=>({closed,allowed,blocked})};
}
describe('hosted release evidence boundaries',()=>{
 it('permits only exact document bytes or the single observed closing-body beacon',()=>{
  const shell='<html><body>public</body></html>',tag='<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/abc" integrity="sha512-abc=" data-cf-beacon=\'{}\' crossorigin="anonymous"></script>\n';
  expect(hostedDocumentMatches(Buffer.from(shell),sha(shell))).toBe(true);
  expect(hostedDocumentMatches(Buffer.from(shell.replace('</body>',tag+'</body>')),sha(shell))).toBe(true);
  for(const text of [shell.replace('</body>',tag+tag+'</body>'),shell.replace('public','changed'),shell.replace('</body>',tag.replace('static.cloudflareinsights.com','elsewhere.invalid')+'</body>')])expect(hostedDocumentMatches(Buffer.from(text),sha(shell))).toBe(false);
 });
 it('rejects bad scope and incomplete evidence before launching',async()=>{
  const f=fixture();let calls=0;const launch=async()=>{calls++;throw Error('unexpected');};
  for(const changed of [{origin:'https://elsewhere.invalid'},{lifetimeMs:0},{candidate:{source:'b'.repeat(40),files:{'a.js':sha('a')}}}])await expect(beginHostedAssetTransition({origin,baseline:f.baseline,candidate:f.candidate,launch,...changed})).rejects.toThrow();
  expect(calls).toBe(0);
 });
});
describe.skipIf(process.env.RELEASE_ASSET_BROWSER_TESTS!=='1')('hosted observer with real Chromium and synthetic transport',()=>{
 for(const worker of ['porchday-staging-edge','porchday-staging'] as const)for(const fault of ['none','exception'] as const)it(`uses real browser ${fault} evidence for ${worker} before completion`,async()=>{
  const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
  const plan:DeploymentPlan={operationId:uuid(1),worker,candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64),...(worker.endsWith('-edge')?{backendVersion:uuid(7),backendReaderFloor:uuid(7)}:{})};
  const root=realpathSync(mkdtempSync(join(tmpdir(),'browser-recovery-'))),f=fixture(fault);
  const observer=await beginHostedAssetTransition({origin,...f});let state:RecoveryState|null=null,current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null},deploys=0;
  try{
   createBrowserGate(root,plan).require();
   const result=await recoverDeployment(plan,{read:async()=>state,write:async(_old,next)=>{state=next;}},{authorize:async()=>{},observe:async()=>({...current}),deploy:async(version,operationId)=>{deploys++;f.switch();current={version,operationId,deploymentId:uuid(version===plan.candidateVersion?5:6)};},verify:withBrowserAcceptance(plan,root,async()=> 'healthy',async()=>{
    expect(state?.phase).toBe('candidate-observed');return (await observer.finish()).passed?'healthy':'unhealthy';
   })},{sleep:async()=>{}});
   expect(result).toBe(fault==='none'?'complete':'rolled-back');expect(deploys).toBe(fault==='none'?1:2);expect(current.version).toBe(fault==='none'?plan.candidateVersion:plan.baselineVersion);
  }finally{await observer.close();rmSync(root,{recursive:true,force:true});}
 });
 for(const fault of ['none','exception','mime','old-bytes','shell'] as const)it(`records the full two-context result: ${fault}`,async()=>{
  const f=fixture(fault),observer=await beginHostedAssetTransition({origin,...f});
  expect(observer.baselineReceipt.authenticated).toBe(false);f.switch();const report=await observer.finish();
  expect(report.oldDocumentRetained).toBe(true);expect(report.newTabRendered).toBe(true);expect(report.passed).toBe(fault==='none');
  if(fault==='exception')expect(report.newErrors.pageErrors).toBeGreaterThan(0);
  if(fault==='mime')expect(report.newErrors.moduleMimeErrors).toBeGreaterThan(0);
  if(fault==='old-bytes')expect(report.assets[0].matchesBaseline).toBe(false);
  if(fault==='shell')expect(report.newDocumentMatches).toBe(false);
  expect(JSON.stringify(report)).not.toContain('private synthetic exception');
  await expect(observer.finish()).rejects.toThrow('FINISH_ALREADY_STARTED');await observer.close();expect(f.counts().closed).toBe(1);
 });
 it('closes on cancellation and does not pretend the candidate was observed',async()=>{
  const f=fixture(),controller=new AbortController(),observer=await beginHostedAssetTransition({origin,...f,signal:controller.signal});
  controller.abort();await expect(observer.finish()).rejects.toThrow();await observer.close();expect(f.counts().closed).toBe(1);
 });
 it('blocks off-origin GET and same-origin POST requests in the fresh client',async()=>{
  const f=fixture('requests'),observer=await beginHostedAssetTransition({origin,...f});f.switch();
  expect((await observer.finish()).passed).toBe(true);expect(f.counts().blocked).toBe(2);expect(f.counts().closed).toBe(1);
 });
 it('closes an abandoned observer at its configured lifetime',async()=>{
  const f=fixture(),observer=await beginHostedAssetTransition({origin,...f,lifetimeMs:1000});
  await new Promise(resolve=>setTimeout(resolve,1100));await expect(observer.finish()).rejects.toThrow('OBSERVER_CLOSED');expect(f.counts().closed).toBe(1);
 });
 it('pins manifests instead of accepting mutations after preparation',async()=>{
  const f=fixture(),observer=await beginHostedAssetTransition({origin,...f});f.candidate.files['index.html']=sha('changed');f.switch();
  expect((await observer.finish()).passed).toBe(true);
 });
 it('refuses missing retained assets before the release can begin',async()=>{
  const f=fixture();delete (f.candidate.files as Record<string,string>)['assets/Lazy-old.js'];
  await expect(beginHostedAssetTransition({origin,...f})).rejects.toThrow('RETENTION_MISSING');expect(f.counts().closed).toBe(1);
 });
});
