import type {ChildProcess} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

const expectedSchema=z.object({operationId:z.uuid(),scopeSha256:z.string().regex(/^[a-f0-9]{64}$/),generation:z.uuid(),memberId:z.uuid(),sessionId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict();
export type CommitDrillExpected=z.infer<typeof expectedSchema>;
export type CommitDrillObservation=CommitDrillExpected&{sequence:string;fenceSequence:string;sessionAbsent:boolean;ownedAccountVerified:boolean;pendingExact:boolean;receiptAbsent:boolean;generationUnchanged:boolean;quarantined:boolean;childReportedCommit:boolean};

/** Parent independently verifies SQL marker/fence and owned session state, plus
 * original journal scope/pending/receipt state. A child message alone is never
 * kill authorization. This proves safe fault placement, NOT recovery. */
export async function killCommittedDrillChild(options:{
 child:ChildProcess;expected:CommitDrillExpected;sealJournal:()=>void;
 observe:(signal:AbortSignal)=>Promise<CommitDrillObservation>;
 retain:(event:{phase:'commit-verified'|'kill-intent'|'killed';pid:number;operationId:string;sequence:string})=>void|Promise<void>;
},signal:AbortSignal){
 const expected=expectedSchema.parse(structuredClone(options.expected)),child=options.child,pid=child.pid;
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
 const assert=()=>{deadline.throwIfAborted();if(!pid||pid<=0||child.pid!==pid||child.killed||child.exitCode!==null||child.signalCode!==null)throw Error('DRILL_CHILD_NOT_PARKED');};
 async function bounded<T>(work:()=>Promise<T>|T):Promise<T>{
  deadline.throwIfAborted();let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(Error('DRILL_SUPERVISION_DEADLINE'));deadline.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([Promise.resolve().then(work),aborted]);}finally{deadline.removeEventListener('abort',stop);}
 }
 assert();options.sealJournal();
 const observed=await bounded(()=>options.observe(deadline));assert();
 const identity=Object.fromEntries(Object.keys(expected).map(key=>[key,observed[key as keyof CommitDrillExpected]]));
 if(!isDeepStrictEqual(identity,expected)||!/^[1-9][0-9]*$/.test(observed.sequence)||observed.sequence!==observed.fenceSequence||
  !observed.sessionAbsent||!observed.ownedAccountVerified||!observed.pendingExact||!observed.receiptAbsent||!observed.generationUnchanged||observed.quarantined||!observed.childReportedCommit)throw Error('DRILL_COMMIT_UNVERIFIED');
 const event={pid:pid!,operationId:expected.operationId,sequence:observed.sequence};
 await bounded(()=>options.retain({phase:'commit-verified',...event}));assert();
 await bounded(()=>options.retain({phase:'kill-intent',...event}));assert();
 let onExit!:(code:number|null,signal:NodeJS.Signals|null)=>void;
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{onExit=(code,signal)=>resolve({code,signal});child.once('exit',onExit);});
 try{
  if(!child.kill('SIGKILL'))throw Error('DRILL_KILL_UNCONFIRMED');
  const result=await bounded(()=>exited);
  if(result.code!==null||result.signal!=='SIGKILL')throw Error('DRILL_EXIT_UNCONFIRMED');
  await bounded(()=>options.retain({phase:'killed',...event}));return{...event,signal:'SIGKILL' as const,recoveryVerified:false as const};
 }finally{child.off('exit',onExit);}
}
