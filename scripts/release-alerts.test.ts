import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {deliverReleaseAlert,queueReleaseAlert,releaseAlertBody,validateReleaseAlert,type ReleaseAlert} from './release-alerts.ts';
import type {GitHubTransport} from './external-monitor-github.ts';
const id='11111111-1111-1111-1111-111111111111',event:ReleaseAlert={v:1,operationId:id,planHash:'a'.repeat(64),worker:'porchday-staging',reason:'verification-unavailable',at:'2026-10-29T00:00:00.000Z'},target={title:'Make release verification handle deployment convergence and preserve precise failure evidence'},bot={login:'github-actions[bot]',type:'Bot'};
const plan={operationId:id,worker:'porchday-staging',candidateVersion:'22222222-2222-2222-2222-222222222222',baselineVersion:'33333333-3333-3333-3333-333333333333',baselineDeploymentId:'44444444-4444-4444-4444-444444444444',compatibleRollbackVersions:['33333333-3333-3333-3333-333333333333'],candidateSource:'b'.repeat(40),evidenceDigest:'c'.repeat(64)};
describe('release attention alerts',()=>{
 it('native relay rejects non-Actions scope without echoing payloads or reaching GitHub',()=>{
  const child=spawnSync(process.execPath,['scripts/release-alert-relay.ts'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false',PORCHDAY_RELEASE_ALERT_PAYLOAD:'private-synthetic-payload',PORCHDAY_MONITOR_GH_PATH:'/nonexistent/porchday-test-gh'}});
  expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr.trim()).toBe('RELEASE_ALERT_DELIVERY_UNCONFIRMED');
 });
 it('native notification retry rejects invalid arguments without echoing paths',()=>{
  const child=spawnSync(process.execPath,['scripts/release-alert-retry.ts','private-synthetic-path','extra'],{encoding:'utf8',env:{...process.env,PORCHDAY_MONITOR_GH_PATH:'/nonexistent/porchday-test-gh'}});
  expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr.trim()).toBe('RELEASE_OWNER_NOTIFICATION_UNCONFIRMED');
 });
 it('rejects arbitrary fields, prose, malformed identity and timestamps',()=>{
  for(const bad of [{...event,password:'secret'},{...event,reason:'private error'},{...event,operationId:[id]},{...event,worker:'arbitrary'},{...event,at:'yesterday'}])expect(()=>validateReleaseAlert(bad)).toThrow();
  expect(releaseAlertBody(event)).toContain('@andyk @bobbyhwilder');expect(releaseAlertBody({...event,reason:'notification-drill'})).toContain('Notification drill: no deployment failure is being reported.');
 });
 it.each(['porchday-monitor-staging','porchday-monitor-production'])('delivers and reconciles an exact %s notification',async worker=>{
  const monitorEvent={...event,worker,reason:'notification-drill' as const};
  expect(()=>validateReleaseAlert(monitorEvent)).not.toThrow();
  const comments:unknown[]=[];let posts=0;
  const transport:GitHubTransport=async(method,path,body)=>{
   if(method==='GET')return path.includes('/comments?')?comments:target;
   posts++;expect(path).toBe('/repos/porchday/porchday/issues/3/comments');
   expect(body).toEqual({body:releaseAlertBody(monitorEvent)});comments.push({...body,user:bot});return null;
  };
  expect(await deliverReleaseAlert(monitorEvent,{transport,bot:true})).toBe('delivered');
  expect(await deliverReleaseAlert(monitorEvent,{transport,bot:true})).toBe('delivered');expect(posts).toBe(1);
 });
 it.each(['porchday-monitor','porchday-monitor-preview','porchday-monitor-production-edge','porchday-monitor-production-extra','porchday-monitor-production\n'])('rejects unsupported monitor identity %j',worker=>{
  expect(()=>validateReleaseAlert({...event,worker})).toThrow();
 });
 it('preserves the first durable alert across repeated failures and rejects changed plans',()=>{
  const d=realpathSync(mkdtempSync(join(tmpdir(),'release-alert-')));try{
   const first=queueReleaseAlert(d,plan,'command-failed',new Date(event.at));
   expect(queueReleaseAlert(d,plan,'rollback-unconfirmed')).toEqual(first);
   expect(JSON.parse(readFileSync(join(d,'attention-'+id+'.json'),'utf8'))).toEqual(first);
   expect(()=>queueReleaseAlert(d,{...plan,evidenceDigest:'d'.repeat(64)},'command-failed')).toThrow('CHANGED');
   chmodSync(d,0o755);expect(()=>queueReleaseAlert(d,plan,'command-failed')).toThrow('DIRECTORY');
  }finally{rmSync(d,{recursive:true,force:true});}
 });
 it('dispatch acceptance is pending until exact bot delivery is observed',async()=>{
  let comments:unknown[]=[{body:releaseAlertBody(event),user:{login:'andyk',type:'User'}}],posts=0;
  const transport:GitHubTransport=async(method,path,body)=>{if(method==='GET')return path.includes('/comments?')?comments:target;posts++;expect(path).toContain('release-alert-relay.yml/dispatches');expect(body).toMatchObject({ref:'main'});return null;};
  expect(await deliverReleaseAlert(event,{transport})).toBe('pending');expect(posts).toBe(1);
  comments=[{body:releaseAlertBody(event),user:bot}];expect(await deliverReleaseAlert(event,{transport})).toBe('delivered');expect(posts).toBe(1);
 });
 it('reconciles a lost comment acknowledgement without repeating the write',async()=>{
  const comments:unknown[]=[];let posts=0;
  const transport:GitHubTransport=async(method,path,body)=>{if(method==='GET')return path.includes('/comments?')?comments:target;posts++;comments.push({...body,user:bot});throw Error('lost reply');};
  await expect(deliverReleaseAlert(event,{transport,bot:true})).rejects.toThrow();
  expect(await deliverReleaseAlert(event,{transport,bot:true})).toBe('delivered');expect(posts).toBe(1);
 });
 it('requires remote readback after a bot POST and never writes in reconcile-only mode',async()=>{
  let posts=0;const transport:GitHubTransport=async(method,path)=>{if(method==='POST'){posts++;return null;}return path.includes('/comments?')?[]:target;};
  expect(await deliverReleaseAlert(event,{transport,bot:true})).toBe('pending');expect(posts).toBe(1);
  expect(await deliverReleaseAlert(event,{transport,reconcileOnly:true})).toBe('pending');expect(posts).toBe(1);
 });
 it('paginates and refuses wrong destinations or conflicting bot evidence',async()=>{
  let pages=0;const transport:GitHubTransport=async(_,path)=>path.includes('/comments?')?(++pages===1?Array.from({length:100},()=>({body:'old'})):[{body:releaseAlertBody(event),user:bot}]):target;
  expect(await deliverReleaseAlert(event,{transport})).toBe('delivered');expect(pages).toBe(2);
  await expect(deliverReleaseAlert(event,{transport:async()=>({title:'other'})})).rejects.toThrow('ISSUE_CHANGED');
  await expect(deliverReleaseAlert(event,{transport:async(_,path)=>path.includes('/comments?')?[{body:releaseAlertBody(event)+'changed',user:bot}]:target})).rejects.toThrow('CONFLICT');
 });
});
