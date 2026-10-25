import {Pool, type PoolClient} from 'pg';
import {z} from 'zod';
import type {Env} from './types';
import {sendAccountEmail} from './email';
import {event} from './telemetry';

const encoder=new TextEncoder();
const context=encoder.encode('Porchday operational email outbox v1');
const payloadSchema=z.object({to:z.email(),subject:z.string().max(200),text:z.string().max(12000)}).strict();
type Message=z.infer<typeof payloadSchema>;

async function key(env:Pick<Env,'BETTER_AUTH_SECRET'>){
 const material=await crypto.subtle.importKey('raw',encoder.encode(env.BETTER_AUTH_SECRET),'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('porchday-email-outbox-v1'),info:context},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptAccountEmail(env:Pick<Env,'BETTER_AUTH_SECRET'>,message:Message){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context},await key(env),encoder.encode(JSON.stringify(payloadSchema.parse(message))));
 return 'v1.'+Buffer.from(iv).toString('base64url')+'.'+Buffer.from(ciphertext).toString('base64url');
}
export async function decryptAccountEmail(env:Pick<Env,'BETTER_AUTH_SECRET'>,envelope:string){
 const parts=envelope.split('.');
 if(parts.length!==3||parts[0]!=='v1')throw new Error('INVALID_MAIL_ENVELOPE');
 const iv=Uint8Array.from(Buffer.from(parts[1],'base64url'));
 if(iv.length!==12)throw new Error('INVALID_MAIL_ENVELOPE');
 const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:context},await key(env),Uint8Array.from(Buffer.from(parts[2],'base64url')));
 return payloadSchema.parse(JSON.parse(new TextDecoder().decode(clear)));
}

/** Call with the request's transaction client so links and outbox commit together. */
export async function enqueueAccountEmail(env:Env,db:Pick<Pool|PoolClient,'query'>,memberId:string,to:string,subject:string,text:string){
 const encrypted=await encryptAccountEmail(env,{to,subject,text});
 await db.query('INSERT INTO public.auth_email_outbox(member_id,encrypted_payload) VALUES($1,$2)',[memberId,encrypted]);
}
/** Queue in the same transaction as the case/token change, without assuming that
 * the contact owns a member account. Superseded one-use links are discarded. */
export async function enqueueRecoveryEmail(env:Env,db:Pick<Pool|PoolClient,'query'>,caseId:string,purpose:'case_contact'|'case_restore'|'case_security',to:string,subject:string,text:string){
 const encrypted=await encryptAccountEmail(env,{to,subject,text});
 if(purpose!=='case_security')await db.query('DELETE FROM public.auth_email_outbox WHERE recovery_case_id=$1 AND purpose=$2 AND delivered_at IS NULL',[caseId,purpose]);
 await db.query('INSERT INTO public.auth_email_outbox(recovery_case_id,purpose,encrypted_payload) VALUES($1,$2,$3)',[caseId,purpose,encrypted]);
}

/** Claims commit before provider I/O; failed sends remain retryable after a crash. */
export async function processAccountEmails(env:Env){
 const pool=new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString,max:1,connectionTimeoutMillis:10000,idleTimeoutMillis:1000});
 let sent=0,retried=0;
 try{
  await pool.query(`DELETE FROM public.auth_email_outbox o WHERE expires_at<=now() OR delivered_at<now()-interval '1 hour' OR failed_at<now()-interval '1 hour'
   OR (member_id IS NOT NULL AND app.auth_member_status(member_id::uuid) IN ('hold','deleting','deleted'))
   OR EXISTS(SELECT 1 FROM public.recovery_cases c WHERE c.id=o.recovery_case_id AND
    (c.retention_until<=now() OR (o.purpose='case_contact' AND(c.contact_token_expires_at<=now() OR c.state='restored'))
     OR (o.purpose='case_restore' AND(c.restore_token_expires_at IS NULL OR c.restore_token_expires_at<=now() OR c.state<>'hold'))))`);
  const lease=crypto.randomUUID();
  const {rows}=await pool.query(`UPDATE public.auth_email_outbox SET leased_until=now()+interval '2 minutes',lease_id=$1,attempts=attempts+1
   WHERE id IN (SELECT id FROM public.auth_email_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND expires_at>now() AND next_attempt_at<=now() AND (leased_until IS NULL OR leased_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10)
   RETURNING id,encrypted_payload,attempts`,[lease]);
  for(const row of rows){
   try{
    const message=await decryptAccountEmail(env,row.encrypted_payload);
    await sendAccountEmail(env,message.to,message.subject,message.text);
    await pool.query('UPDATE public.auth_email_outbox SET delivered_at=now(),leased_until=NULL,lease_id=NULL WHERE id=$1 AND lease_id=$2',[row.id,lease]);
    sent++;
   }catch{
    await pool.query(`UPDATE public.auth_email_outbox SET leased_until=NULL,lease_id=NULL,
     next_attempt_at=now()+make_interval(secs=>least(900,15*power(2,least(attempts,6)))::int),
     failed_at=CASE WHEN attempts>=8 THEN now() ELSE NULL END WHERE id=$1 AND lease_id=$2`,[row.id,lease]);
    retried++;
   }
  }
  if(sent||retried)event('email',{code:retried?'outbox_retry':'outbox_delivered',count:sent,environment:env.ENVIRONMENT});
  return {sent,retried};
 }finally{await pool.end();}
}
