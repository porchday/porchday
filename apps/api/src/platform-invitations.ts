import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authPool, hashToken } from './auth';
import { encryptAccountEmail, processAccountEmails } from './email-outbox';
import { invitationRecipientKey, invitationHistoryRecipient, recordInvitationHistory } from './invitation-history';
import type { Env, Variables } from './types';

const input = z.object({email:z.email().max(254),kind:z.enum(['friend','family']).optional()}).strict();
const accepted = {accepted:true,message:'If eligible, an invitation will be emailed.'};
const cursorSchema=z.object({at:z.iso.datetime(),id:z.uuid()}).strict();

/** Mounted after normal verified-member, Origin, incident and privacy guards. */
export function createPlatformInvitationRoutes() {
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.get('/platform-invitations',async c=>{
  let cursor:z.infer<typeof cursorSchema>|null=null;
  try {
   const value=c.req.query('cursor');
   if(value){if(value.length>256||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();cursor=cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString()));}
  }catch{return c.json({error:{code:'INVALID_CURSOR',message:'Reload the invitation list.'}},400);}
  const pool=authPool(c.env);
  try {
   const actor=await pool.query(`SELECT 1 FROM public.auth_session s
    WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND app.auth_member_status(s."userId"::uuid) IN('active','restricted')`,[c.get('sessionId'),c.get('memberId')]);
   if(!actor.rowCount)return c.json({error:{code:'ACCOUNT_UNAVAILABLE',message:'Sign in to view your invitations.'}},403);
   const {rows}=await pool.query(`SELECT id,sender_id,recipient_key,encrypted_recipient,requested_at,expires_at,connection_kind,
    to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
    CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN joined_at IS NOT NULL OR EXISTS(SELECT FROM public.auth_user u WHERE u.id=claimed_user AND u."emailVerified")
     THEN 'joined' WHEN expires_at<=now() THEN 'expired' ELSE 'pending' END AS status
    FROM public.platform_invitation_history WHERE sender_id=$1 AND requested_at>now()-interval '90 days'
    AND ($2::timestamptz IS NULL OR (requested_at,id)<($2::timestamptz,$3::uuid))
    ORDER BY requested_at DESC,id DESC LIMIT 51`,[c.get('memberId'),cursor?.at||null,cursor?.id||null]);
   const page=rows.slice(0,50),last=page.at(-1);
   const items=await Promise.all(page.map(async row=>({id:row.id,email:await invitationHistoryRecipient(c.env,row),requested_at:row.requested_at,expires_at:row.expires_at,status:row.status==='revoked' && c.req.query('v')!=='2'?'expired':row.status,kind:row.connection_kind})));
   return c.json({items,next_cursor:rows.length>50&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null});
  }finally{c.executionCtx.waitUntil(pool.end());}
 });
 app.use('/platform-invitations',bodyLimit({maxSize:2048,onError:c=>c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400)}));
 app.post('/platform-invitations',async c=>{
  if(c.env.SIGNUP_ENABLED!=='true')return c.json({error:{code:'PILOT_CLOSED',message:'Invitations are not open in this environment.'}},403);
  let parsed:ReturnType<typeof input.safeParse>;
  try {
   const value=await c.req.json();
   parsed=input.safeParse(value&&typeof value==='object'?{...value,email:typeof value.email==='string'?value.email.trim().toLowerCase():value.email}:value);
  }catch{return c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400);}
  if(!parsed.success)return c.json({error:{code:'INVALID_EMAIL',message:'Enter one valid email address.'}},400);
  const email=parsed.data.email,key=await invitationRecipientKey(c.env.BETTER_AUTH_SECRET,email);
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
   const receipt=await db.query('INSERT INTO public.platform_invitation_requests(sender_id,recipient_key,issued) VALUES($1,$2,$3) RETURNING created_at',[c.get('memberId'),key,issue]);
   if(issue){
    const bytes=crypto.getRandomValues(new Uint8Array(32)),token=Buffer.from(bytes).toString('base64url'),tokenHash=await hashToken(token);
    const link=new URL('/join',c.env.APP_URL);link.hash='invite='+token;
    const invitation=await db.query("INSERT INTO public.pilot_invitations(token_hash,email,expires_at,sender_id,connection_kind) VALUES($1,$2,now()+interval '7 days',$3,$4) RETURNING expires_at",[tokenHash,email,c.get('memberId'),parsed.data.kind||null]);
    const deadline=new Date(invitation.rows[0].expires_at).toISOString();
    const text=`@${actor.rows[0].handle} invited you to join Porchday, a simple social network.\n\nCreate an account using this private invitation link:\n${link.href}\n\nOr visit ${new URL('/join',c.env.APP_URL).href} and enter this invitation code:\n${token}\n\nThis invitation is for this email address only and can be used once. It expires at ${deadline} (seven days after it was requested). The pilot is for adults 18 and older. ${parsed.data.kind ? `Accepting this invitation and verifying your email automatically connects you and @${actor.rows[0].handle} as ${parsed.data.kind === 'family' ? 'Family' : 'Friends'}. You will share future posts for that audience, not past posts. Each of you can change your own label or disconnect later.` : 'Joining does not automatically connect you to the inviter.'}\n\nIf you do not want to join, ignore this email. No account has been created for you. Please do not forward this invitation.`;
    const encrypted=await encryptAccountEmail(c.env,{to:email,subject:'You are invited to Porchday',text});
    await db.query("INSERT INTO public.auth_email_outbox(member_id,purpose,invitation_token_hash,encrypted_payload,expires_at) VALUES($1,'platform_invitation',$2,$3,$4)",[c.get('memberId'),tokenHash,encrypted,deadline]);
   }
   // Associate only this sender's actual invitation. Never reveal another
   // sender's invitation, an existing account, suppression or mail delivery.
   const own=await db.query(`SELECT i.token_hash,i.expires_at,i.consumed_user,i.connection_kind,
    CASE WHEN u."emailVerified" THEN coalesce(i.claimed_at,i.created_at) END AS joined_at
    FROM public.pilot_invitations i LEFT JOIN public.auth_user u ON u.id=i.consumed_user
    WHERE i.sender_id=$1 AND i.email=$2 ORDER BY i.created_at DESC LIMIT 1`,[c.get('memberId'),email]);
   const prior=own.rows[0],requestedAt=new Date(receipt.rows[0].created_at);
   await recordInvitationHistory(db,c.env,{sender:c.get('memberId'),email,key,requestedAt,
    expiresAt:prior?new Date(prior.expires_at):new Date(requestedAt.getTime()+7*24*60*60_000),
    tokenHash:prior?.token_hash||null,claimedUser:prior?.consumed_user,joinedAt:prior?.joined_at,connectionKind:prior?prior.connection_kind:parsed.data.kind});
   if(prior)await db.query('UPDATE public.pilot_invitations SET history_recorded=true WHERE token_hash=$1',[prior.token_hash]);
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
 app.post('/platform-invitations/:id/revoke',async c=>{
  if(!z.uuid().safeParse(c.req.param('id')).success)return c.json({error:{code:'NOT_FOUND'}},404);
  const pool=authPool(c.env),db=await pool.connect();
  try {
   await db.query('BEGIN');
   const actor=await db.query(`SELECT 1 FROM public.auth_session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()
    AND app.auth_member_status($2::uuid) IN('active','restricted')`,[c.get('sessionId'),c.get('memberId')]);
   if(!actor.rowCount){await db.query('ROLLBACK');return c.json({error:{code:'ACCOUNT_UNAVAILABLE'}},403);}
   const initial=await db.query('SELECT invitation_token_hash FROM public.platform_invitation_history WHERE id=$1 AND sender_id=$2',[c.req.param('id'),c.get('memberId')]);
   if(!initial.rowCount){await db.query('ROLLBACK');return c.json({error:{code:'NOT_FOUND'}},404);}
   const token=initial.rows[0].invitation_token_hash;
   if(token)await db.query('SELECT token_hash FROM public.pilot_invitations WHERE token_hash=$1 FOR UPDATE',[token]);
   const result=await db.query('SELECT * FROM public.platform_invitation_history WHERE id=$1 AND sender_id=$2 FOR UPDATE',[c.req.param('id'),c.get('memberId')]);
   const row=result.rows[0];
   if(!row || row.invitation_token_hash!==token){await db.query('ROLLBACK');return c.json({error:{code:'INVITATION_CHANGED'}},409);}
   if(row.joined_at){await db.query('ROLLBACK');return c.json({error:{code:'ALREADY_JOINED',message:'They have already joined. Manage your connection separately.'}},409);}
   if(!row.revoked_at){
    await db.query('UPDATE public.platform_invitation_history SET revoked_at=now() WHERE id=$1',[row.id]);
    if(token)await db.query('UPDATE public.pilot_invitations SET revoked_at=now(),expires_at=least(expires_at,now()) WHERE token_hash=$1',[token]);
   }
   await db.query('COMMIT');return c.json({revoked:true});
  } finally {await db.query('ROLLBACK').catch(()=>{});db.release();c.executionCtx.waitUntil(pool.end());}
 });
 return app;
}
