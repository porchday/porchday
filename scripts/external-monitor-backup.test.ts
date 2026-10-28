import {describe,expect,it} from 'vitest';
import {runBackup,notificationDrill} from './external-monitor-backup';
import {alertBody,type AlertEvent} from './external-monitor-alerts';
import {latestHostedEvent,previousHostedExecutionFailed,type GitHubTransport} from './external-monitor-github';
import type {ProbeConfig,Observation,probe} from './external-monitor-probe';
const id='00000000-0000-4000-8000-000000000002';
const config:ProbeConfig&{issue:number}={environment:'production',healthToken:'h'.repeat(32),synthetic:{id,email:id+'@example.test',password:'p'.repeat(32)},issue:53};
const base=Date.parse('2026-10-28T21:00:00Z');
const bot={login:'github-actions[bot]',type:'Bot'};
const event:AlertEvent={id:'earlier-outage',kind:'outage',at:new Date(base-300000).toISOString(),failedChecks:['login']};
function fixture(results:boolean[],initial:{id:number;body:string;user:typeof bot}[]=[],loseWriteReply=false){
 const comments=[...initial],observations:Observation[]=[];let now=base,writes=0,index=0,lost=false;
 const transport:GitHubTransport=async(method,path,body)=>{
  if(method==='POST'){
   writes++;comments.push({id:comments.length+100,body:(body as {body:string}).body,user:bot});
   if(loseWriteReply&&!lost){lost=true;throw Error('LOST_WRITE_ACK');}return {};
  }
  if(path.includes('/comments?'))return comments;
  return {title:'External production availability alerts (github-backup)'};
 };
 const probeFn:typeof probe=async()=>{
  const healthy=results[index++]??true;
  return {v:1,at:new Date(now).toISOString(),environment:'production',healthy,checks:[{name:'login',ok:healthy}],durationMs:1,scope:'login_authorized_reads_logout_and_readiness'};
 };
 return {comments,observations,writes:()=>writes,options:{transport,probe:probeFn,now:()=>now,sleep:async(ms:number)=>{now+=ms;},observe:(value:Observation)=>observations.push(value)}};
}
describe('hosted backup monitor',()=>{
 it('records two independent observations without notifying while healthy',async()=>{
  const f=fixture([true,true]);expect(await runBackup(config,f.options)).toEqual({healthy:true,notificationsDelivered:true});
  expect(f.writes()).toBe(0);expect(f.observations).toHaveLength(2);
  expect(Date.parse(f.observations[1].at)-Date.parse(f.observations[0].at)).toBe(20000);
 });
 it('suppresses an unchanged outage across fresh runner processes',async()=>{
  const f=fixture([false,false]);expect((await runBackup(config,f.options)).healthy).toBe(false);expect(f.writes()).toBe(1);
  const next=fixture([false,false],f.comments);await runBackup(config,next.options);expect(next.writes()).toBe(0);
 });
 it('requires two fresh successes before reporting recovery',async()=>{
  const f=fixture([true,true],[{id:1,body:alertBody(event,'github-backup'),user:bot}]);
  await runBackup(config,f.options);expect(f.writes()).toBe(1);expect(f.comments[1].body).toContain('checks recovered');
  const failed=fixture([true,false],[{id:1,body:alertBody(event,'github-backup'),user:bot}]);
  await runBackup(config,failed.options);expect(failed.writes()).toBe(0);
 });
 it('reconciles an uncertain successful notification within the job',async()=>{
  const f=fixture([false,false],[],true);expect((await runBackup(config,f.options)).notificationsDelivered).toBe(true);expect(f.writes()).toBe(1);
 });
 it('retains observations when the GitHub state API is unavailable',async()=>{
  const f=fixture([false,true]);
  const result=await runBackup(config,{...f.options,transport:async()=>{throw Error('SECRET_RESPONSE');}});
  expect(result).toEqual({healthy:false,notificationsDelivered:false});expect(f.observations).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('SECRET_RESPONSE');
 });
 it('reports a prior execution gap and recovery even when the next application checks pass',async()=>{
  const f=fixture([true,true]);
  expect(await runBackup(config,{...f.options,previousExecutionFailed:true})).toEqual({healthy:true,notificationsDelivered:true});
  expect(f.writes()).toBe(2);expect(f.comments[0].body).toContain('backup_execution');expect(f.comments[1].body).toContain('checks recovered');
 });
 it('does not duplicate a known outage merely because the previous workflow failed',async()=>{
  const f=fixture([false,false],[{id:1,body:alertBody(event,'github-backup'),user:bot}]);
  await runBackup(config,{...f.options,previousExecutionFailed:true});expect(f.writes()).toBe(0);
 });
 it('detects failed, cancelled and stale executions but excludes current and future jobs',async()=>{
  const run={id:9,head_branch:'main',event:'schedule',status:'completed',conclusion:'success',updated_at:new Date(base-300000).toISOString()};
  const lookup=(patch:object={})=>previousHostedExecutionFailed('10',async()=>({workflow_runs:[{...run,id:11,conclusion:'failure'},{...run,id:10,conclusion:null},{...run,...patch}]}),base);
  expect(await lookup()).toBe(false);
  for(const conclusion of ['failure','cancelled','timed_out'])expect(await lookup({conclusion})).toBe(true);
  expect(await lookup({updated_at:new Date(base-13*60000).toISOString()})).toBe(true);
  expect(await previousHostedExecutionFailed('10',async()=>({workflow_runs:[]}),base)).toBe(false);
 });
 it('refuses staging or ordinary member credentials before any probe',async()=>{
  const f=fixture([true,true]);
  await expect(runBackup({...config,environment:'staging'},f.options)).rejects.toThrow('PRODUCTION_ONLY');
  await expect(runBackup({...config,synthetic:{...config.synthetic,email:'member@example.com'}},f.options)).rejects.toThrow();
  expect(f.observations).toHaveLength(0);
 });
 it('ignores human comments, drills, forged bodies and out-of-order older events',async()=>{
  const recovery:AlertEvent={...event,id:'recovery',kind:'recovery',failedChecks:[]};
  const comments=[
   {id:10,body:alertBody(recovery,'github-backup'),user:bot},
   {id:11,body:alertBody(event,'github-backup'),user:{login:'human',type:'User'}},
   {id:12,body:alertBody(event,'github-backup',true),user:bot},
   {id:13,body:alertBody(event,'github-backup')+'\nforged',user:bot},
   {id:9,body:alertBody(event,'github-backup'),user:bot},
  ];
  const f=fixture([],comments);expect(await latestHostedEvent(53,f.options.transport)).toEqual(recovery);
 });
 it('delivers an explicit drill once across reruns without changing live outage state',async()=>{
  const f=fixture([]);
  const transport:GitHubTransport=async(method,path,body)=>path.endsWith('/actions/runs/10')?{id:10,created_at:new Date(base).toISOString(),head_branch:'main',repository:{full_name:'porchday/porchday'}}:f.options.transport(method,path,body);
  await notificationDrill(53,'10',transport);await notificationDrill(53,'10',transport);
  expect(f.writes()).toBe(2);expect(f.comments.every(c=>c.body.includes('Notification drill'))).toBe(true);
  expect(await latestHostedEvent(53,transport)).toBe(null);
 });
});
