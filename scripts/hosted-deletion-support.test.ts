import {describe,it,expect,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {finalOutboxComplete,issueDeletion,syntheticC,ticketHash,validateDeletionTicket,type DeletionState,type DeletionTicket} from './hosted-deletion-support.js';
import {stagingOrigin} from './hosted-smoke-support.js';
const now=Date.now();
function fixture(){
 const run='123456abcd';
 const state:DeletionState={v:1,synthetic:true,origin:stagingOrigin,run,socialPassed:true,accounts:[0,1,2].map(i=>({id:randomUUID(),email:`synthetic+porchday-${i}@example.invalid`,password:'p'.repeat(40),handle:`qa_${run}_${i}`}))};
 const c=state.accounts[2],mediaId=randomUUID();
 const ticket:DeletionTicket={v:1,synthetic:true,origin:stagingOrigin,run,memberId:c.id,handle:c.handle,createdAt:new Date(now).toISOString(),bucket:'porchday-staging-media',branchId:'synthetic-branch-id',protectedMembers:state.accounts.slice(0,2).map(a=>a.id),sessions:[0,1].map(i=>({id:`synthetic-session-${i}`,cookie:`__Secure-better-auth.session_token=synthetic-${i}`})),deviceIds:[randomUUID()],postIds:[randomUUID()],commentIds:[],media:[{id:mediaId,object_key:`media/${c.id}/${mediaId}`,sha256:'a'.repeat(64),byte_size:1234,expires_at:new Date(now+3600000).toISOString()}],journal:{generation:randomUUID(),sequence:'18'}};
 return {state,ticket};
}
describe('Synthetic account deletion boundaries',()=>{
 it('refuses missing/extra arguments before credentials or private state are read',()=>{
  for(const args of [['prepare'],['request'],['status'],['request','--run','--account=B'],['cleanup','--run']]){
   const result=spawnSync(process.execPath,['--import','tsx','scripts/hosted-account-deletion.ts',...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
   expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr)).toEqual({phase:args[0],error:'DELETION_EXPLICIT_PHASE_REQUIRED'});
  }
 });
 it('binds an immutable ticket to C, staging, the known member-owned object keys, and protected A/B',()=>{
  const {state,ticket}=fixture();expect(syntheticC(state).id).toBe(state.accounts[2].id);expect(()=>validateDeletionTicket(ticket,state,now,true)).not.toThrow();
  expect(()=>validateDeletionTicket({...ticket,memberId:state.accounts[1].id},state,now,true)).toThrow('DELETION_TICKET_IDENTITY_INVALID');
  expect(()=>validateDeletionTicket({...ticket,origin:'https://porchday.com' as typeof stagingOrigin},state,now,true)).toThrow('DELETION_TICKET_IDENTITY_INVALID');
  expect(()=>validateDeletionTicket({...ticket,protectedMembers:[]},state,now,true)).toThrow('DELETION_PROTECTED_ACCOUNTS_MISMATCH');
  expect(()=>validateDeletionTicket({...ticket,media:[{...ticket.media[0],object_key:`media/${state.accounts[0].id}/${ticket.media[0].id}`}]},state,now,true)).toThrow('DELETION_MEDIA_EVIDENCE_INVALID');
  expect(()=>validateDeletionTicket({...ticket,media:[]},state,now,true)).toThrow('DELETION_LIVE_FIXTURES_REQUIRED');
  expect(()=>validateDeletionTicket({...ticket,createdAt:new Date(now-3*3600000).toISOString()},state,now,true)).toThrow('DELETION_TICKET_EXPIRED');
  expect(()=>validateDeletionTicket({...ticket,media:[{...ticket.media[0],expires_at:new Date(now+600000).toISOString()}]},state,now,true)).toThrow('DELETION_MEDIA_EVIDENCE_INVALID');
  expect(ticketHash({...ticket,postIds:[]})).not.toBe(ticketHash(ticket));
 });
 it('writes the exclusive intent before exactly one API deletion and never retries an uncertain outcome',async()=>{
  const order:string[]=[];
  await issueDeletion({persistIntent:async()=>{order.push('intent');},removeAccount:async()=>{order.push('normal-member-api');},persistReceipt:async()=>{order.push('receipt');}});
  expect(order).toEqual(['intent','normal-member-api','receipt']);
  const deletion=vi.fn(),receipt=vi.fn();
  await expect(issueDeletion({persistIntent:async()=>{throw Error('existing immutable intent');},removeAccount:deletion,persistReceipt:receipt})).rejects.toThrow();expect(deletion).not.toHaveBeenCalled();
  const uncertain=vi.fn(async()=>{throw Error('network outcome unknown');});
  await expect(issueDeletion({persistIntent:async()=>{},removeAccount:uncertain,persistReceipt:receipt})).rejects.toThrow();expect(uncertain).toHaveBeenCalledTimes(1);expect(receipt).not.toHaveBeenCalled();
 });
 it('requires each exact object, two actual worker attempts, and the ten-minute final-pass floor',()=>{
  const {ticket}=fixture(),row={object_key:ticket.media[0].object_key,attempts:2,created_at:new Date(now).toISOString(),completed_at:new Date(now+600001).toISOString()};
  expect(finalOutboxComplete([row],ticket)).toBe(true);
  expect(finalOutboxComplete([{...row,attempts:1}],ticket)).toBe(false);
  expect(finalOutboxComplete([{...row,completed_at:new Date(now+599999).toISOString()}],ticket)).toBe(false);
  expect(finalOutboxComplete([{...row,completed_at:null}],ticket)).toBe(false);
  expect(finalOutboxComplete([],ticket)).toBe(false);
  expect(finalOutboxComplete([{...row,object_key:'media/another-member/another-photo'}],ticket)).toBe(false);
 });
});
