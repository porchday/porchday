import {setTimeout as sleep} from 'node:timers/promises';
import {probeReleaseContinuity,type ContinuitySample} from './release-continuity.ts';

type ProbeOptions=Parameters<typeof probeReleaseContinuity>[0];
export type ContinuityCommandStatus='complete'|'rolled-back'|'attention-required';
export type ContinuityCommandEvent=
 |{kind:'sample';index:number;phaseAtStart:'baseline'|'command-running'|'command-terminal';sample:ContinuitySample}
 |{kind:'command-intent';at:string}
 |{kind:'command-terminal';at:string;status:ContinuityCommandStatus|'failed';failureCode?:string};

// Explicit public diagnostics only. Never retain arbitrary exception messages,
// stacks, causes or code-like values supplied by a provider or caller.
const diagnosticCodes=new Set([
 'DEPLOYMENT_CONTINUITY_FAILED','DEPLOYMENT_READER_FLOOR_NOT_ACKNOWLEDGED','DEPLOYMENT_CANONICAL_CHANGED',
 'DEPLOYMENT_LEASE_HELD','DEPLOYMENT_JOURNAL_CONFLICT',
 'RELEASE_CI_NOT_SUCCESSFUL','ACTIVATION_TOOLING_WORKSPACE_CHANGED',
 'MONITOR_RECOVERY_EVIDENCE_EXPIRED','MONITOR_RELEASE_HISTORY_CHANGED',
]);
function commandFailureCode(error:unknown):string{
 try{const message=error instanceof Error?Object.getOwnPropertyDescriptor(error,'message')?.value:undefined;
  return typeof message==='string'&&diagnosticCodes.has(message)?message:'COMMAND_ERROR_REDACTED';
 }catch{return 'COMMAND_ERROR_REDACTED';}
}

/** Coordinates observation with ONE invocation of an existing durable release
 * command. This is not a provider transport, lease or replay authorization.
 * runCommand must honor cancellation and settle only after its child/callbacks
 * have stopped. retain must durably append before resolving. The caller owns
 * operation identity, fixture lifetime, provider milestones and reconciliation.
 */
export async function runCommandWithContinuity(options:ProbeOptions & {
 runCommand:(signal:AbortSignal)=>Promise<ContinuityCommandStatus>;
 retain:(event:ContinuityCommandEvent)=>Promise<void>;
 intervalMs?:number;maxSamples?:number;placementTrial?:true;
},signal:AbortSignal){
 const interval=options.intervalMs??2000,limit=options.maxSamples??120;
 if(!Number.isSafeInteger(interval)||interval<1000||interval>5000||!Number.isSafeInteger(limit)||limit<3||limit>(options.placementTrial?4500:120)||options.placementTrial!==undefined&&options.placementTrial!==true||options.placementTrial&&limit*interval<65*60*1000)throw Error('CONTINUITY_COMMAND_SCOPE');
 const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
 let command:Promise<void>|undefined,terminal=false;
 const outcome:{status:ContinuityCommandStatus|'failed';failureCode?:string}={status:'failed'};
 let samples=0,failedSamples=0,postCommandSamples=0,maxStartGapMs=0,previous:number|undefined;
 let terminalRetained=false,terminalAt='';
 const assert=()=>{combined.throwIfAborted();options.assertScope();};
 try{
  for(;samples<limit;){
   assert();
   const tick=performance.now(),phaseAtStart=command?(terminal?'command-terminal':'command-running'):'baseline';
   if(previous!==undefined)maxStartGapMs=Math.max(maxStartGapMs,tick-previous);previous=tick;
   const sample=await probeReleaseContinuity(options,combined);
   await options.retain({kind:'sample',index:samples,phaseAtStart,sample:structuredClone(sample)});
   samples++;if(!sample.healthy)failedSamples++;assert();
   if(!command){
    if(!sample.healthy)throw Error('CONTINUITY_BASELINE_FAILED');
    await options.retain({kind:'command-intent',at:new Date().toISOString()});assert();
    // Retain intent first. A rejected or synchronously throwing command is never
    // retried; its own durable journal remains the authority for reconciliation.
    command=Promise.resolve().then(()=>{assert();return options.runCommand(combined);}).then(value=>{
     outcome.status=['complete','rolled-back','attention-required'].includes(value)?value:'failed';
    },error=>{outcome.status='failed';outcome.failureCode=commandFailureCode(error);}).finally(()=>{terminalAt=new Date().toISOString();terminal=true;});
   }
   if(terminal&&!terminalRetained){
    await options.retain({kind:'command-terminal',at:terminalAt,status:outcome.status,...(outcome.failureCode?{failureCode:outcome.failureCode}:{})});terminalRetained=true;
   }
   if(phaseAtStart==='command-terminal')postCommandSamples++;
   if(postCommandSamples>=2){
    if(failedSamples)throw Error('CONTINUITY_SAMPLES_FAILED');
    if(outcome.status!=='complete'&&outcome.status!=='rolled-back')throw Error('CONTINUITY_COMMAND_UNVERIFIED');
    return {status:outcome.status,samples,failedSamples,postCommandSamples,maxStartGapMs};
   }
   if(samples<limit)await sleep(Math.max(0,interval-(performance.now()-tick)),undefined,{signal:combined});
  }
  throw Error('CONTINUITY_COMMAND_SAMPLE_LIMIT');
 }finally{
  // Do not detach a still-running release or allow fixture/lease cleanup while
  // its command is alive, including when observation or evidence storage fails.
  controller.abort();await command;
 }
}
