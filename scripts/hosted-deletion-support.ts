/** Guardrails for the bounded synthetic-C deletion check. No credentials or content are logged. */
import {createHash} from 'node:crypto';
import {check,SmokeError,stagingOrigin} from './hosted-smoke-support.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DeletionAccount={id:string;email:string;password:string;handle:string;deleted?:boolean};
export type DeletionState={v:1;synthetic:true;origin:string;run:string;socialPassed:boolean;accounts:DeletionAccount[]};
export type MediaEvidence={id:string;object_key:string;sha256:string;byte_size:number;expires_at:string|null};
export type DeletionTicket={
 v:1;synthetic:true;origin:typeof stagingOrigin;run:string;memberId:string;handle:string;createdAt:string;
 bucket:'porchday-staging-media';branchId:string;protectedMembers:string[];
 sessions:{id:string;cookie:string}[];deviceIds:string[];postIds:string[];commentIds:string[];
 media:MediaEvidence[];journal:{generation:string;sequence:string};
};
export type DeletionIntent={v:1;ticketSHA256:string;startedAt:string;session:{id:string;cookie:string}};
export type DeletionReceipt={v:1;ticketSHA256:string;acknowledgedAt:string};
export function ticketHash(ticket:DeletionTicket){return createHash('sha256').update(JSON.stringify(ticket)).digest('hex');}
export function syntheticC(state:DeletionState,allowDeleted=false):DeletionAccount{
 check(state.v===1&&state.synthetic===true&&state.origin===stagingOrigin&&/^[a-f0-9]{10}$/.test(state.run)&&state.socialPassed&&state.accounts?.length===3,'DELETION_SYNTHETIC_STATE_REQUIRED');
 check(new Set(state.accounts.map(a=>a.id)).size===3&&state.accounts.every((a,i)=>uuid.test(a.id)&&a.handle===`qa_${state.run}_${i}`&&/^[^\s@]+\+porchday-[^\s@]+@[^\s@]+$/.test(a.email)&&typeof a.password==='string'&&a.password.length>=32),'DELETION_SYNTHETIC_IDENTITIES_INVALID');
 const c=state.accounts[2];check(allowDeleted||!c.deleted,'DELETION_ALREADY_RECORDED');return c;
}
export function validateDeletionTicket(ticket:DeletionTicket,state:DeletionState,now=Date.now(),fresh=false){
 const c=syntheticC(state,true);
 check(ticket.v===1&&ticket.synthetic===true&&ticket.origin===stagingOrigin&&ticket.run===state.run&&ticket.memberId===c.id&&ticket.handle===c.handle&&ticket.bucket==='porchday-staging-media'&&/^[a-zA-Z0-9_-]{10,100}$/.test(ticket.branchId),'DELETION_TICKET_IDENTITY_INVALID');
 check(JSON.stringify(ticket.protectedMembers)===JSON.stringify(state.accounts.slice(0,2).map(a=>a.id)),'DELETION_PROTECTED_ACCOUNTS_MISMATCH');
 const created=Date.parse(ticket.createdAt);check(Number.isFinite(created)&&created<=now+5000&&(!fresh||created>now-2*3600000),'DELETION_TICKET_EXPIRED');
 check(ticket.sessions?.length===2&&new Set(ticket.sessions.map(s=>s.id)).size===2&&ticket.sessions.every(s=>typeof s.id==='string'&&s.id.length>10&&typeof s.cookie==='string'&&s.cookie.length>20&&s.cookie.length<16384&&!/[\r\n]/.test(s.cookie)),'DELETION_SESSION_EVIDENCE_INVALID');
 for(const ids of [ticket.deviceIds,ticket.postIds,ticket.commentIds])check(Array.isArray(ids)&&ids.length<=1000&&new Set(ids).size===ids.length&&ids.every(id=>uuid.test(id)),'DELETION_OBJECT_IDS_INVALID');
 check(ticket.deviceIds.length>0&&ticket.postIds.length>0&&ticket.media?.length>0&&ticket.media.length<=32,'DELETION_LIVE_FIXTURES_REQUIRED');
 check(new Set(ticket.media.map(m=>m.id)).size===ticket.media.length&&ticket.media.every(m=>uuid.test(m.id)&&m.object_key===`media/${c.id}/${m.id}`&&/^[a-f0-9]{64}$/.test(m.sha256)&&Number.isSafeInteger(m.byte_size)&&m.byte_size>0&&m.byte_size<=22020096&&(m.expires_at===null||(Number.isFinite(Date.parse(m.expires_at))&&(!fresh||Date.parse(m.expires_at)>now+15*60000)))),'DELETION_MEDIA_EVIDENCE_INVALID');
 check(uuid.test(ticket.journal.generation)&&/^(0|[1-9][0-9]*)$/.test(ticket.journal.sequence),'DELETION_JOURNAL_EVIDENCE_INVALID');
}
/** The durable exclusive intent must finish before the sole destructive HTTP request. */
export async function issueDeletion(io:{persistIntent:()=>Promise<void>;removeAccount:()=>Promise<unknown>;persistReceipt:()=>Promise<void>}){
 await io.persistIntent();await io.removeAccount();await io.persistReceipt();
}
export function finalOutboxComplete(rows:{object_key:string;attempts:number;created_at:string;completed_at:string|null}[],ticket:DeletionTicket){
 return rows.length===ticket.media.length&&ticket.media.every(m=>{
  const row=rows.find(r=>r.object_key===m.object_key);
  return !!row&&row.attempts>=2&&row.completed_at!==null&&Date.parse(row.completed_at)>=Date.parse(row.created_at)+10*60000;
 });
}

/** Keep provider messages, SQL text, parameter values and cookie-bearing errors private. */
export function deletionFailure(error:unknown,stage:string){
 const allowedStages=new Set(['SETUP','STATUS_SESSIONS','STATUS_DATABASE_COUNTS','STATUS_PROTECTED_ACCOUNTS','STATUS_LEDGER','STATUS_OUTBOXES','STATUS_MEDIA_ABSENCE','STATUS_JOURNAL','STATUS_RETAINED_BACKUP_METADATA']);
 if(error instanceof SmokeError&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message))return {error:error.message};
 const e=(error&&typeof error==='object'?error:{}) as {name?:unknown;code?:unknown;where?:unknown};
 const parameter=typeof e.where==='string'?e.where.match(/parameter \$(\d+)/):null;
 return {error:'HOSTED_ACCOUNT_DELETION_CHECK_FAILED',stage:allowedStages.has(stage)?stage:'SETUP',
  ...(typeof e.name==='string'&&['PostgresError','TypeError','SyntaxError','ZodError'].includes(e.name)?{category:e.name}:{}),
  ...(typeof e.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code)?{sqlstate:e.code}:{}),
  ...(parameter?{parameter:Number(parameter[1])}:{})};
}
