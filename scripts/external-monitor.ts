import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {probe,validateProbeConfig,type ProbeConfig} from './external-monitor-probe';
import {advance} from './external-monitor-alerts';
import {deliver} from './external-monitor-github';
import {privateFile,privateDirectory,readState,persistState,record} from './external-monitor-store';

async function main(){
 const [configPath,directory,mode]=process.argv.slice(2);
 if(!configPath||!directory||!['--once','--continuous'].includes(mode))throw Error('MONITOR_ARGUMENTS');
 const config=JSON.parse(privateFile(resolve(configPath))) as ProbeConfig&{issue:number};validateProbeConfig(config);
 if(config.environment!=='production'||!Number.isSafeInteger(config.issue)||config.issue<1)throw Error('MONITOR_PRODUCTION_CONFIGURATION');
 const stateDirectory=resolve(directory);privateDirectory(stateDirectory);
 let state=readState(stateDirectory),stopping=false,delivery:Promise<void>|undefined,retryAfter=0;
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const save=()=>persistState(stateDirectory,state);
 const flush=()=>{
  if(delivery||Date.now()<retryAfter||state.pending.length===0)return;
  delivery=(async()=>{
   while(state.pending.length&&!stopping){
    const event=state.pending[0];
    try{
     await deliver(config.issue,event,'operator-mac');
     // Probe completions may have appended events during delivery; preserve them.
     state={...state,pending:state.pending.filter(candidate=>candidate.id!==event.id)};save();
     console.log(JSON.stringify({at:new Date().toISOString(),event:'notification_delivered',kind:event.kind}));
    }catch{
     retryAfter=Date.now()+60000;
     console.log(JSON.stringify({at:new Date().toISOString(),event:'notification_pending'}));break;
    }
   }
  })().finally(()=>{delivery=undefined;});
 };
 do{
  const started=Date.now(),observation=await probe(config);
  record(stateDirectory,observation);state=advance(state,observation,randomUUID());save();flush();
  console.log(JSON.stringify({at:observation.at,event:'probe',healthy:observation.healthy,durationMs:observation.durationMs,pendingNotifications:state.pending.length}));
  if(mode==='--once')break;
  // No overlapping probes and no catch-up burst after sleep, outage or restart.
  if(!stopping)await sleep(Math.max(0,20000-(Date.now()-started)));
 }while(!stopping);
 await delivery;
 if(mode==='--once'&&(state.incident||state.pending.length))process.exitCode=1;
}
main().catch(()=>{console.error('EXTERNAL_MONITOR_STOPPED');process.exitCode=1;});
