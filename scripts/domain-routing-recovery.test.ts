import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileRoutingJournal} from './domain-routing-journal.ts';
import {recoverRouting,type RoutingState,type RoutingPlan,type DomainTarget,type RoutingPorts} from './domain-routing-recovery.ts';
const plan:RoutingPlan={operationId:'11111111-1111-4111-8111-111111111111',moves:['porchday.org','www.porchday.org'].map(hostname=>({before:{hostname,service:'porchday-production',environment:'production',zoneId:'a'.repeat(32)},after:{hostname,service:'porchday-production-edge',environment:'production',zoneId:'a'.repeat(32)}}))};
function fixture(){
 let state:RoutingState|null=null;
 const live=new Map(plan.moves.map(m=>[m.before.hostname,m.before]));
 const writes:DomainTarget[]=[];
 const ports:RoutingPorts={read:async()=>state,write:async(previous,next)=>{expect(previous).toBe(state);expect(next.revision).toBe((state?.revision??0)+1);state=next;},authorize:async()=>{},observe:async name=>live.get(name)!,assign:async target=>{expect(state?.intent).toBe(true);writes.push(target);live.set(target.hostname,target);}};
 return {ports,live,writes};
}
describe('domain routing recovery',()=>{
 it('resumes from durable records in a new journal instance',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'routing-'));
  try {
   const f=fixture(),journal=new FileRoutingJournal(directory,plan);
   f.ports.read=()=>journal.read();f.ports.write=(p,n)=>journal.write(p,n);
   f.ports.assign=async target=>{f.writes.push(target);f.live.set(target.hostname,target);};
   expect(await recoverRouting(plan,f.ports)).toBe('complete');
   const resumed=new FileRoutingJournal(directory,plan);
   f.ports.read=()=>resumed.read();f.ports.write=(p,n)=>resumed.write(p,n);
   expect(await recoverRouting(plan,f.ports,true)).toBe('rolled-back');
   expect(f.writes).toHaveLength(4);
  } finally {rmSync(directory,{recursive:true,force:true});}
 });
 it('refuses truncated durable records without provider writes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'routing-'));
  try {
   writeFileSync(join(directory,'00001.json'),'{',{mode:0o600});
   const f=fixture(),journal=new FileRoutingJournal(directory,plan);f.ports.read=()=>journal.read();
   await expect(recoverRouting(plan,f.ports)).rejects.toThrow('JOURNAL_INVALID');expect(f.writes).toHaveLength(0);
  } finally {rmSync(directory,{recursive:true,force:true});}
 });
 it('moves and restores all domains in reverse order',async()=>{
  const f=fixture();expect(await recoverRouting(plan,f.ports)).toBe('complete');
  expect(await recoverRouting(plan,f.ports,true)).toBe('rolled-back');
  expect(f.writes.map(t=>t.hostname)).toEqual(['porchday.org','www.porchday.org','www.porchday.org','porchday.org']);
 });
 it('reconciles accepted writes with lost replies',async()=>{
  const f=fixture(),assign=f.ports.assign;f.ports.assign=async t=>{await assign(t);throw Error('lost response');};
  expect(await recoverRouting(plan,f.ports)).toBe('complete');expect(f.writes).toHaveLength(2);
 });
 it('never replays an uncertain write, including when asked to roll back',async()=>{
  const f=fixture();let calls=0;f.ports.assign=async()=>{calls++;throw Error('unknown');};
  expect(await recoverRouting(plan,f.ports)).toBe('write-unconfirmed');
  expect(await recoverRouting(plan,f.ports,true)).toBe('write-unconfirmed');expect(calls).toBe(1);
 });
 it('recovers partial cutover after interruption and restores the confirmed domain',async()=>{
  const f=fixture(),observe=f.ports.observe;let interrupted=false;
  f.ports.observe=async n=>{if(f.writes.length===1&&!interrupted){interrupted=true;throw Error('interrupted');}return observe(n);};
  await expect(recoverRouting(plan,f.ports)).rejects.toThrow('interrupted');
  expect(await recoverRouting(plan,f.ports,true)).toBe('rolled-back');expect(f.writes).toHaveLength(2);
 });
 it('refuses unexpected ownership before issuing writes',async()=>{
  const f=fixture();f.live.set('porchday.org',{...plan.moves[0].before,service:'unknown'});
  await expect(recoverRouting(plan,f.ports)).rejects.toThrow('ROUTING_CONCURRENT_CHANGE');expect(f.writes).toHaveLength(0);
 });
});
