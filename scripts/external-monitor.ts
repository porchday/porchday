import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {probe,validateProbeConfig,type ProbeConfig} from './external-monitor-probe';
import {advance} from './external-monitor-alerts';
import {createRelayDrainer} from './external-monitor-delivery';
import {privateFile,privateDirectory,readState,persistState,record} from './external-monitor-store';

async function main(){
 const [configPath,directory,mode]=process.argv.slice(2);
 if(!configPath||!directory||!['--once','--continuous'].includes(mode))throw Error('MONITOR_ARGUMENTS');
 const config=JSON.parse(privateFile(resolve(configPath))) as ProbeConfig&{issue:number};validateProbeConfig(config);
 if(config.environment!=='production'||!Number.isSafeInteger(config.issue)||config.issue<1)throw Error('MONITOR_PRODUCTION_CONFIGURATION');
 const stateDirectory=resolve(directory);privateDirectory(stateDirectory);
 let state=readState(stateDirectory),stopping=false;
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const save=()=>persistState(stateDirectory,state);
 const drainer=createRelayDrainer({issue:config.issue,read:()=>state,write:next=>{persistState(stateDirectory,next);state=next;},stopping:()=>stopping,
  notify:(event,kind)=>console.log(JSON.stringify({at:new Date().toISOString(),event,...(kind?{kind}:{})}))});
 const timer=mode==='--continuous'?setInterval(()=>{void drainer.flush();},5000):undefined;
 try{
 do{
  const started=Date.now(),observation=await probe(config);
  record(stateDirectory,observation);state=advance(state,observation,randomUUID());save();void drainer.flush();
  console.log(JSON.stringify({at:observation.at,event:'probe',healthy:observation.healthy,durationMs:observation.durationMs,pendingNotifications:state.pending.length}));
  if(mode==='--once'){await drainer.flush();break;}
  // No overlapping probes and no catch-up burst after sleep, outage or restart.
  if(!stopping)await sleep(Math.max(0,20000-(Date.now()-started)));
 }while(!stopping);
 }finally{if(timer)clearInterval(timer);stopping=true;await drainer.flush();}
 if(mode==='--once'&&(state.incident||state.pending.length))process.exitCode=1;
}
main().catch(()=>{console.error('EXTERNAL_MONITOR_STOPPED');process.exitCode=1;});
