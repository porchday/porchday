import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authPool, hashToken } from './auth';
import { encryptAccountEmail, processAccountEmails } from './email-outbox';
import type { Env, Variables } from './types';

const input = z.object({email:z.email().max(254)}).strict();
const accepted = {accepted:true,message:'If eligible, an invitation will be emailed. It does not create a friendship.'};
const hex = (bytes:ArrayBuffer) => [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
async function recipientKey(secret:string,email:string) {
 const encoder=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,encoder.encode('porchday-platform-invitation\0'+email)));
}

/** Mounted after normal verified-member, Origin, incident and privacy guards. */
export function createPlatformInvitationRoutes() {
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('/platform-invitations',bodyLimit({maxSize:2048,onError:c=>c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400)}));
 app.post('/platform-invitations',async c=>{
  if(c.env.SIGNUP_ENABLED!=='true')return c.json({error:{code:'PILOT_CLOSED',message:'Invitations are not open in this environment.'}},403);
  let parsed:ReturnType<typeof input.safeParse>;
  try {
   const value=await c.req.json();
   parsed=input.safeParse(value&&typeof value==='object'?{...value,email:typeof value.email==='string'?value.email.trim().toLowerCase():value.email}:value);
  }catch{return c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400);}
  if(!parsed.success)return c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400);
  const email=parsed.data.email,key=await recipientKey(c.env.BETTER_AUTH_SECRET,email);
  const pool=authPool(c.env),db=await pool.connect();
  let committed=false;
  try {
   await db.query('BEGIN');
   // Serialize sender quota and then recipient dedup across all senders. Locks
   // cover only local SQL/encryption; email is delivered after the commit.
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-platform-sender:'||$1,0))",[c.get('memberId')]);
   const actor=await db.query(`SELECT app.platform_inviter($1) AS handle WHERE EXISTS(
    SELECT FROM public.auth_session WHERE id=$2 AND "userId"=$1 AND "expiresAt">now())`,[c.get('memberId'),c.get('sessionId')]);
   if(!actor.rows[0]?.handle){await db.query('ROLLBACK');return c.json({error:{code:'ACCOUNT_UNAVAILABLE',message:'An active, verified account is required to invite someone.'}},403);}
   const quota=await db.query(`SELECT count(*)::int AS count,least(86400,greatest(1,ceil(extract(epoch FROM(min(created_at)+interval '1 day'-now())))))::int AS retry
    FROM public.platform_invitation_requests WHERE sender_id=$1 AND created_at>now()-interval '1 day'`,[c.get('memberId')]);
   if(quota.rows[0].count>=10){await db.query('ROLLBACK');c.header('Retry-After',String(quota.rows[0].retry));return c.json({error:{code:'INVITATION_LIMIT',message:'You can request up to 10 invitations in 24 hours. Please try later.'}},429);}
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-platform-recipient:'||$1,0))",[key]);
   const eligible=await db.query(`SELECT NOT EXISTS(SELECT FROM public.auth_user WHERE lower(email)=$1)
    AND NOT EXISTS(SELECT FROM public.pilot_invitations WHERE email=$1 AND expires_at>now() AND consumed_user IS NULL)
    AND NOT EXISTS(SELECT FROM public.platform_invitation_requests WHERE recipient_key=$2 AND issued AND created_at>now()-interval '7 days') AS value`,[email,key]);
   const issue=eligible.rows[0].value===true;
   await db.query('INSERT INTO public.platform_invitation_requests(sender_id,recipient_key,issued) VALUES($1,$2,$3)',[c.get('memberId'),key,issue]);
   if(issue){
    const bytes=crypto.getRandomValues(new Uint8Array(32)),token=Buffer.from(bytes).toString('base64url'),tokenHash=await hashToken(token);
    const link=new URL('/join',c.env.APP_URL);link.hash='invite='+token;
    const invitation=await db.query("INSERT INTO public.pilot_invitations(token_hash,email,expires_at,sender_id) VALUES($1,$2,now()+interval '7 days',$3) RETURNING expires_at",[tokenHash,email,c.get('memberId')]);
    const deadline=new Date(invitation.rows[0].expires_at).toISOString();
    const text=`@${actor.rows[0].handle} invited you to join Porchday, a simple social network.\n\nCreate an account using this private invitation link:\n${link.href}\n\nOr visit ${new URL('/join',c.env.APP_URL).href} and enter this invitation code:\n${token}\n\nThis invitation is for this email address only and can be used once. It expires at ${deadline} (seven days after it was requested). The pilot is for adults 18 and older. Joining does not automatically connect you to the inviter.\n\nIf you do not want to join, ignore this email. No account has been created for you. Please do not forward this invitation.`;
    const encrypted=await encryptAccountEmail(c.env,{to:email,subject:'You are invited to Porchday',text});
    await db.query("INSERT INTO public.auth_email_outbox(member_id,purpose,invitation_token_hash,encrypted_payload,expires_at) VALUES($1,'platform_invitation',$2,$3,$4)",[c.get('memberId'),tokenHash,encrypted,deadline]);
   }
   await db.query('COMMIT');committed=true;
   // Response never reveals recipient existence, duplicate suppression or mail
   // delivery. A response loss is safe to repeat: quota/dedup prevent more mail.
   c.executionCtx.waitUntil(processAccountEmails(c.env));
   return c.json(accepted,202);
  } finally {
   if(!committed)await db.query('ROLLBACK').catch(()=>{});
   db.release();c.executionCtx.waitUntil(pool.end());
  }
 });
 return app;
}
