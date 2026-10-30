import {fork} from 'node:child_process';
import {URL} from 'node:url';
import {z} from 'zod';
import type {Sql} from 'postgres';
import type {JournalStore} from '../apps/api/src/privacy-journal';
import {createCommitDrillStore} from './commit-drill-store';
import {serveCommitDrillJournal} from './commit-drill-ipc';
import {commitDrillFixtureSchema,type CommitDrillFixture} from './commit-drill-transaction';
import {observeCommittedDrill} from './commit-drill-observe';
import {killCommittedDrillChild} from './commit-drill-supervisor';

const phaseSchema=z.discriminatedUnion('phase',[
 z.object({type:z.literal('phase'),phase:z.literal('registered'),operationId:z.uuid()}).strict(),
 z.object({type:z.literal('phase'),phase:z.literal('scoped'),operationId:z.uuid(),scopeSha256:z.string().regex(/^[a-f0-9]{64}$/),generation:z.uuid()}).strict(),
 z.object({type:z.literal('phase'),phase:z.literal('committed'),operationId:z.uuid(),sequence:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
]);

export function validateCommitDrillPhase(input:unknown,expected:{stage:number;operationId?:string;generation:string;publicationSha256?:string}){
 const phase=phaseSchema.parse(input);
 if(phase.operationId!==expected.operationId||
  !(expected.stage===0&&phase.phase==='registered'||
   expected.stage===1&&phase.phase==='scoped'&&phase.generation===expected.generation&&phase.scopeSha256===expected.publicationSha256||
   expected.stage===2&&phase.phase==='committed'))throw Error('DRILL_PHASE_INVALID');
 return phase;
}

/** Requires a private durable sink, owned fixture and held deployment lease at
 * assertScope. This only establishes a committed, receipt-less process loss.
 * Caller must observe normal hosted recovery and perform exact fixture cleanup. */
export async function runCommitDrillChild(options:{
 target:'staging'|'local-test';connection:string;fixture:CommitDrillFixture;generation:string;
 store:JournalStore;sql:Sql;assertScope:()=>void;retain:(record:Record<string,unknown>)=>void|Promise<void>;
},signal:AbortSignal){
 const fixture=commitDrillFixtureSchema.parse(structuredClone(options.fixture)),generation=z.uuid().parse(options.generation);
 const protocolAbort=new AbortController();
 const deadline=AbortSignal.any([signal,protocolAbort.signal,AbortSignal.timeout(60000)]);
 const assert=()=>{deadline.throwIfAborted();options.assertScope();};
 const retain=async(record:Record<string,unknown>)=>{
  assert();let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(Error('DRILL_RETENTION_DEADLINE'));deadline.addEventListener('abort',stop,{once:true});});
  try{await Promise.race([Promise.resolve().then(()=>{assert();return options.retain(record);}),aborted]);assert();}finally{deadline.removeEventListener('abort',stop);}
 };
 let publicationSha256:string|undefined;
 const gate=createCommitDrillStore({store:options.store,assertScope:assert,retain:async event=>{
  await retain({kind:'journal',...event});
  if(event.phase==='intent'&&event.method==='put'&&event.key.startsWith('commit-scopes/v1/'))publicationSha256=event.valueSha256;
 }});
 await retain({kind:'spawn-intent',target:options.target});
 const child=fork(new URL('./commit-drill-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH},stdio:['ignore','ignore','ignore','ipc']});
 let initialized=false,stage=0,settled=false;let scope:{operationId:string;scopeSha256:string;generation:string}|undefined;
 let resolve!:(value:{operationId:string;sequence:string})=>void,reject!:(error:Error)=>void;
 const committed=new Promise<{operationId:string;sequence:string}>((yes,no)=>{resolve=yes;reject=no;});
 // Attach a handler before asynchronous persistence, so early exit is retained
 // as failure without an unhandled rejection or a second child spawn.
 void committed.catch(()=>{});
 const fail=()=>{gate.close();if(!settled){settled=true;reject(Error('DRILL_CHILD_RECONCILIATION_REQUIRED'));}if(!protocolAbort.signal.aborted)protocolAbort.abort();};
 const server=serveCommitDrillJournal({send:message=>{if(!child.send(message as never))throw Error('DRILL_IPC_BACKPRESSURE');},subscribe:receive=>{
  const listener=(message:any)=>{if(message?.type==='journal')receive(message);};child.on('message',listener);return()=>{child.off('message',listener);};
 }},gate.store,()=>{gate.close();fail();});
 let chain=Promise.resolve(),received=0;
 const onMessage=(message:any)=>{
  if(message?.type==='journal')return;
  if(++received>3){fail();return;}
  chain=chain.then(async()=>{
   assert();const phase=validateCommitDrillPhase(message,{stage,operationId:gate.operationId(),generation,publicationSha256});stage++;
   if(phase.phase==='scoped')scope={operationId:phase.operationId,scopeSha256:phase.scopeSha256,generation:phase.generation};
   await retain({kind:'child-phase',...phase});
   if(phase.phase==='committed'&&!settled){settled=true;resolve({operationId:phase.operationId,sequence:phase.sequence});}
  }).catch(fail);
 };
 const onExit=()=>{if(!settled)fail();};child.on('message',onMessage);child.once('exit',onExit);child.once('error',fail);deadline.addEventListener('abort',fail,{once:true});
 try{
  await retain({kind:'spawned',pid:child.pid});assert();initialized=true;
  if(!child.send({type:'init',target:options.target,connection:options.connection,fixture}))throw Error('DRILL_INIT_UNCONFIRMED');
  const reported=await committed;await chain;assert();if(!scope||!publicationSha256)throw Error('DRILL_SCOPE_UNCONFIRMED');
  const expected={...scope,memberId:fixture.memberId,sessionId:fixture.sessionId};
  return await killCommittedDrillChild({child,expected,sealJournal:()=>gate.close(),observe:proofSignal=>observeCommittedDrill({sql:options.sql,store:options.store,fixture,expected,publicationSha256:publicationSha256!,reportedSequence:reported.sequence},proofSignal),retain:event=>retain({kind:'supervisor',...event})},deadline);
 }catch{
  // Never kill a potentially registered or running transaction on failure. Seal
  // R2 access and disconnect; the bounded child exits and outcome is reconciled.
  gate.close();if(!initialized&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  if(child.connected)child.disconnect();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.resolve().then(()=>options.retain({kind:'reconciliation-required',pid:child.pid,operationId:gate.operationId(),stage,automaticRetry:false})),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}catch{/* Prior durable intent remains authoritative. */}finally{if(timer)clearTimeout(timer);}
  throw Error('DRILL_RUN_RECONCILIATION_REQUIRED');
 }finally{gate.close();server.close();child.off('message',onMessage);child.off('exit',onExit);child.off('error',fail);deadline.removeEventListener('abort',fail);}
}
