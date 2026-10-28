import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {probe,validateProbeConfig,type ProbeConfig,type Observation} from './external-monitor-probe.ts';
import {advance,initialState} from './external-monitor-alerts.ts';
import {deliver,latestHostedEvent,previousHostedExecutionFailed,ghTransport,type GitHubTransport} from './external-monitor-github.ts';

/** Two separate observations permit verified recovery without overlapping journeys. */
export async function runBackup(config:ProbeConfig&{issue:number},options:{
 transport?:GitHubTransport;probe?:typeof probe;sleep?:(ms:number)=>Promise<unknown>;now?:()=>number;
 previousExecutionFailed?:boolean;
 observe:(observation:Observation)=>void;
}):Promise<{healthy:boolean;notificationsDelivered:boolean}>{
 validateProbeConfig(config);
 if(config.environment!=='production')throw Error('HOSTED_MONITOR_PRODUCTION_ONLY');
 let state=initialState(),stateAvailable=true,allHealthy=true;
 try{const previous=await latestHostedEvent(config.issue,options.transport);state.incident=previous?.kind==='outage';}
 catch{stateAvailable=false;}
 const now=options.now??Date.now;
 if(stateAvailable&&!state.incident&&options.previousExecutionFailed){
  state.incident=true;
  state.pending.push({id:randomUUID(),kind:'outage',at:new Date(now()).toISOString(),failedChecks:['backup_execution']});
 }
 for(let sample=0;sample<2;sample++){
  const started=now(),observation=await (options.probe??probe)(config);
  options.observe(observation);allHealthy=allHealthy&&observation.healthy;
  state=advance(state,observation,randomUUID());
  if(stateAvailable){
   while(state.pending.length){
    try{await deliver(config.issue,state.pending[0],'github-backup',{transport:options.transport,requireBot:true});state.pending.shift();}
    catch{break;}
   }
  }
  if(sample===0)await (options.sleep??sleep)(Math.max(0,20000-(now()-started)));
 }
 return {healthy:allHealthy,notificationsDelivered:stateAvailable&&state.pending.length===0};
}

export async function notificationDrill(issue:number,runId:string,transport:GitHubTransport=ghTransport):Promise<void>{
 if(!/^\d+$/.test(runId)||runId.length>20)throw Error('INVALID_WORKFLOW_RUN');
 const run=await transport('GET',`/repos/porchday/porchday/actions/runs/${runId}`) as {id?:number;created_at?:string;head_branch?:string;repository?:{full_name?:string}};
 const at=Date.parse(run.created_at??'');
 if(String(run.id)!==runId||run.head_branch!=='main'||run.repository?.full_name!=='porchday/porchday'||!Number.isFinite(at))throw Error('INVALID_WORKFLOW_RUN');
 // Stable IDs and timestamps make re-running the same drill idempotent.
 await deliver(issue,{id:`drill-${runId}-outage`,kind:'outage',at:new Date(at).toISOString(),failedChecks:['protected_readiness']},'github-backup',{transport,drill:true,requireBot:true});
 await deliver(issue,{id:`drill-${runId}-recovery`,kind:'recovery',at:new Date(at+20000).toISOString(),failedChecks:[]},'github-backup',{transport,drill:true,requireBot:true});
}

async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='porchday/porchday'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('HOSTED_MONITOR_CONTEXT');
 const config=JSON.parse(process.env.PORCHDAY_EXTERNAL_MONITOR_CONFIG??'null');
 // Remove the scoped synthetic configuration from the environment inherited by gh.
 delete process.env.PORCHDAY_EXTERNAL_MONITOR_CONFIG;
 let previousExecutionFailed=false,executionHistoryAvailable=true;
 try{previousExecutionFailed=await previousHostedExecutionFailed(process.env.GITHUB_RUN_ID??'');}catch{executionHistoryAvailable=false;}
 const result=await runBackup(config,{previousExecutionFailed,observe:observation=>console.log(JSON.stringify({source:'github-backup',...observation}))});
 console.log(JSON.stringify({source:'github-backup',...result,executionHistoryAvailable,previousExecutionFailed}));
 if(process.env.PORCHDAY_MONITOR_NOTIFICATION_DRILL==='true'){
  if(!result.healthy||!result.notificationsDelivered||!executionHistoryAvailable)throw Error('DRILL_REQUIRES_HEALTHY_MONITOR');
  await notificationDrill(config.issue,process.env.GITHUB_RUN_ID??'');
  console.log('HOSTED_NOTIFICATION_DRILL_GITHUB_ACCEPTED');
 }
 if(!result.healthy||!result.notificationsDelivered||!executionHistoryAvailable)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('HOSTED_MONITOR_FAILED');process.exitCode=1;});
