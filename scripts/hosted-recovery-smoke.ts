/** Bounded stolen-account contact test for synthetic staging member B only.
 * The owner verifies delivered links in their inbox. Never read tokens from SQL.
 */
import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {check,readPrivate,writePrivate,SmokeClient,SmokeError,stagingOrigin} from './hosted-smoke-support.js';

const directory='artifacts/private/hosted-smoke/',phase=process.argv[2];
const ticketPath=directory+'recovery-test.json';
type Ticket={v:1;run:string;startedAt:string;reportAccepted?:boolean;resumeStartedAt?:string;resumeAccepted?:boolean};
let sql:ReturnType<typeof postgres>|undefined;
try{
 check(['report','status','resume'].includes(phase)&&process.argv.length===4&&process.argv[3]==='--run','RECOVERY_TEST_ARGUMENTS');
 const state=await readPrivate<any>(directory+'state.json');
 check(state.v===1&&state.synthetic===true&&state.origin===stagingOrigin&&/^[a-f0-9]{10}$/.test(state.run)&&state.accounts?.length===3,'SYNTHETIC_STATE_REQUIRED');
 const member=state.accounts[1];
 check(member.handle==='qa_'+state.run+'_1'&&member.email.includes('+porchday-')&&member.password.length>=32&&!member.deleted,'SYNTHETIC_MEMBER_REQUIRED');
 const api=new SmokeClient();
 await api.json('/api/auth/sign-in/email','POST',{email:member.email,password:member.password});
 const me=await api.json('/api/v1/me');check(me.id===member.id,'SYNTHETIC_LOGIN_MISMATCH');
 let ticket:Ticket;
 if(phase==='report'){
  ticket={v:1,run:state.run,startedAt:new Date().toISOString()};
  // Persist before the request; an uncertain result must be inspected, not resent.
  await writePrivate(ticketPath,ticket,true);
  await api.json('/api/account-recovery/reports','POST',{
   accountReference:member.handle,safeEmail:member.email,
   trustedMethod:'Synthetic owner-controlled email test; no real account is compromised.',
   description:'Porchday hosted contact-verification test '+state.run+'. Do not restore or hold this synthetic account.',
  },202);
  ticket.reportAccepted=true;await writePrivate(ticketPath,ticket);
  console.log(JSON.stringify({phase,accepted:true,contactVerificationPending:true}));
 }else{
  ticket=await readPrivate<Ticket>(ticketPath);check(ticket.v===1&&ticket.run===state.run&&Number.isFinite(Date.parse(ticket.startedAt)),'RECOVERY_TEST_TICKET_INVALID');
  const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
  const value=process.env.PORCHDAY_STAGING_DATABASE_MIGRATION_URL;check(value,'STAGING_DATABASE_REQUIRED');
  const url=new URL(value);
  check(url.hostname.endsWith('.pg.psdb.cloud')&&decodeURIComponent(url.username).endsWith('.'+resources.environments.staging.database.branch_id)&&url.port==='5432','STAGING_DATABASE_MISMATCH');
  sql=postgres(value,{max:1,prepare:false,fetch_types:false,connect_timeout:10,ssl:'verify-full',onnotice:()=>{}});
  // Only case metadata is read. Mail tokens, session hashes and evidence are never selected.
  const rows=await sql`select id,state,contact_verified_at is not null as verified from public.recovery_cases
   where account_reference=${member.handle} and lower(safe_email)=${member.email.toLowerCase()} and created_at>=${ticket.startedAt}::timestamptz`;
  check(rows.length===1,'RECOVERY_TEST_CASE_COUNT');const record=rows[0];
  check(['contact_pending','submitted'].includes(record.state),'RECOVERY_TEST_UNEXPECTED_STATE');
  if(phase==='resume'){
   check(record.verified&&record.state==='submitted'&&!ticket.resumeStartedAt,'RECOVERY_TEST_RESUME_NOT_READY');
   ticket.resumeStartedAt=new Date().toISOString();await writePrivate(ticketPath,ticket);
   await api.json('/api/account-recovery/resume','POST',{caseId:record.id,safeEmail:member.email},202);
   ticket.resumeAccepted=true;await writePrivate(ticketPath,ticket);
  }
  check((await api.json('/api/v1/me')).id===member.id,'REPORT_CHANGED_ACCOUNT_ACCESS');
  console.log(JSON.stringify({phase,caseState:record.state,contactVerified:record.verified,memberAccessUnchanged:true,...(phase==='resume'?{accepted:true}:{})}));
 }
}catch(error){
 console.error(JSON.stringify({phase,error:error instanceof SmokeError?error.message:'HOSTED_RECOVERY_CHECK_FAILED'}));process.exitCode=1;
}finally{await sql?.end({timeout:1});}
