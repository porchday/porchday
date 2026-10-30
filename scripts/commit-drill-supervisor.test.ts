import {EventEmitter,once} from 'node:events';
import {spawn,fork,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import {killCommittedDrillChild,type CommitDrillObservation} from './commit-drill-supervisor';

function fixture(){
 const expected={operationId:randomUUID(),scopeSha256:'a'.repeat(64),generation:randomUUID(),memberId:randomUUID(),sessionId:randomUUID()};
 const observation:CommitDrillObservation={...expected,sequence:'4',fenceSequence:'4',sessionAbsent:true,ownedAccountVerified:true,pendingExact:true,receiptAbsent:true,generationUnchanged:true,quarantined:false,childReportedCommit:true};
 const child=Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null,killed:false,kill:vi.fn(()=>{child.killed=true;queueMicrotask(()=>child.emit('exit',null,'SIGKILL'));return true;})}) as unknown as ChildProcess;
 return{expected,observation,child,sealJournal:vi.fn(),retain:vi.fn(async()=>{}),observe:vi.fn(async()=>observation)};
}

test('retains verified evidence and kill intent before signaling, then requires SIGKILL exit',async()=>{
 const f=fixture(),order:string[]=[];f.retain.mockImplementation(async event=>{order.push(event.phase);expect(f.child.killed).toBe(event.phase==='killed');});
 const result=await killCommittedDrillChild(f,new AbortController().signal);
 expect(order).toEqual(['commit-verified','kill-intent','killed']);expect(f.sealJournal).toHaveBeenCalledTimes(1);expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');expect(result.recoveryVerified).toBe(false);
});

test.each(['sessionAbsent','ownedAccountVerified','pendingExact','receiptAbsent','generationUnchanged','childReportedCommit'] as const)('missing %s never authorizes a kill',async key=>{
 const f=fixture();f.observation[key]=false;await expect(killCommittedDrillChild(f,new AbortController().signal)).rejects.toThrow('COMMIT_UNVERIFIED');expect(f.child.kill).not.toHaveBeenCalled();expect(f.retain).not.toHaveBeenCalled();
});

test.each(['operationId','generation','memberId','sessionId','scopeSha256','fenceSequence','sequence','quarantined'])('mismatched %s never authorizes a kill',async key=>{
 const f=fixture();(f.observation as any)[key]=key==='quarantined'?true:key==='scopeSha256'?'b'.repeat(64):key==='sequence'?'0':'changed';
 await expect(killCommittedDrillChild(f,new AbortController().signal)).rejects.toThrow('COMMIT_UNVERIFIED');expect(f.child.kill).not.toHaveBeenCalled();
});

test('evidence persistence failure prevents signaling',async()=>{
 const f=fixture();f.retain.mockRejectedValue(Error('local sink unavailable'));await expect(killCommittedDrillChild(f,new AbortController().signal)).rejects.toThrow();expect(f.child.kill).not.toHaveBeenCalled();
});

test('aborted verification cannot kill later even if its pending observation resolves',async()=>{
 const f=fixture(),abort=new AbortController();let resolve!:(value:CommitDrillObservation)=>void;f.observe.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const promise=killCommittedDrillChild(f,abort.signal);await Promise.resolve();abort.abort();await expect(promise).rejects.toThrow();resolve(f.observation);await Promise.resolve();expect(f.child.kill).not.toHaveBeenCalled();
});

test('real owned process exit is confirmed without treating it as recovery evidence',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');const f=fixture();
 try{const result=await killCommittedDrillChild({...f,child},AbortSignal.timeout(5000));expect(result.signal).toBe('SIGKILL');expect(result.pid).toBe(child.pid);expect(result.recoveryVerified).toBe(false);}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

test.each(['staging','local-test'])('real child refuses a non-staging connection for %s before journal access',async target=>{
 const child=fork(new URL('./commit-drill-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH},stdio:['ignore','ignore','ignore','ipc']});
 const messages:unknown[]=[];child.on('message',m=>messages.push(m));const exited=once(child,'exit');
 const connection=new URL('postgres://production.invalid:5432/porchday_commit_proof_test');connection.username='synthetic.private';connection.password='synthetic-test-only';
 child.send({type:'init',target,connection:connection.href,fixture:{runId:randomUUID(),memberId:randomUUID(),sessionId:randomUUID()}});
 try{const [code]=await exited;expect(code).toBe(1);expect(messages).toEqual([{type:'phase',phase:'failed',code:'DRILL_CHILD_RECONCILIATION_REQUIRED'}]);expect(JSON.stringify(messages)).not.toContain(connection.password);}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
