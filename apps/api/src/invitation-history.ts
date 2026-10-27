import type { Pool, PoolClient } from 'pg';
import { decryptAccountEmail, encryptAccountEmail } from './email-outbox';
import type { Env } from './types';

export async function invitationRecipientKey(secret:string,email:string) {
 const encoder=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,encoder.encode('porchday-platform-invitation\0'+email));
 return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

type HistoryInput={sender:string;email:string;key:string;requestedAt:Date;expiresAt:Date;tokenHash:string|null;claimedUser?:string|null;joinedAt?:Date|null};
/** Every accepted request gets a receipt, including suppressed requests. */
export async function recordInvitationHistory(db:Pick<Pool|PoolClient,'query'>,env:Env,input:HistoryInput) {
 const encrypted=await encryptAccountEmail(env,{to:input.email,subject:'Porchday invitation receipt',text:input.sender+'\n'+input.key});
 await db.query(`INSERT INTO public.platform_invitation_history
  (id,sender_id,recipient_key,encrypted_recipient,requested_at,expires_at,invitation_token_hash,claimed_user,joined_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT(sender_id,recipient_key) DO UPDATE SET
   encrypted_recipient=EXCLUDED.encrypted_recipient,
   requested_at=greatest(platform_invitation_history.requested_at,EXCLUDED.requested_at),
   expires_at=CASE WHEN EXCLUDED.requested_at>=platform_invitation_history.requested_at THEN EXCLUDED.expires_at ELSE platform_invitation_history.expires_at END,
   invitation_token_hash=CASE WHEN EXCLUDED.requested_at>=platform_invitation_history.requested_at THEN EXCLUDED.invitation_token_hash ELSE platform_invitation_history.invitation_token_hash END,
   claimed_user=coalesce(platform_invitation_history.claimed_user,EXCLUDED.claimed_user),
   joined_at=coalesce(platform_invitation_history.joined_at,EXCLUDED.joined_at)`,
  [crypto.randomUUID(),input.sender,input.key,encrypted,input.requestedAt,input.expiresAt,input.tokenHash,input.claimedUser||null,input.joinedAt||null]);
}

export async function invitationHistoryRecipient(env:Env,row:{sender_id:string;recipient_key:string;encrypted_recipient:string}) {
 const receipt=await decryptAccountEmail(env,row.encrypted_recipient);
 if(receipt.subject!=='Porchday invitation receipt'||receipt.text!==row.sender_id+'\n'+row.recipient_key)throw Error('INVALID_INVITATION_RECEIPT');
 return receipt.to;
}

/** Preserve still-retained older invitations before normal credential cleanup.
 * Bounded and idempotent; no email is sent and no token is made valid again.
 */
export async function captureLegacyInvitations(db:Pick<Pool|PoolClient,'query'>,env:Env) {
 const {rows}=await db.query(`SELECT i.sender_id,i.email,i.token_hash,i.created_at,i.expires_at,i.consumed_user,
  CASE WHEN u."emailVerified" THEN coalesce(i.claimed_at,i.created_at) END AS joined_at
  FROM public.pilot_invitations i LEFT JOIN public.auth_user u ON u.id=i.consumed_user
  WHERE i.sender_id IS NOT NULL AND NOT i.history_recorded AND i.created_at>now()-interval '90 days'
  ORDER BY i.created_at DESC LIMIT 100 FOR UPDATE OF i SKIP LOCKED`);
 for(const row of rows) {
  const key=await invitationRecipientKey(env.BETTER_AUTH_SECRET,row.email);
  // A newer receipt may already represent the same recipient. Never replace it
  // with an older credential or repeatedly backfill an old superseded token.
  await recordInvitationHistory(db,env,{sender:row.sender_id,email:row.email,key,requestedAt:row.created_at,expiresAt:row.expires_at,tokenHash:row.token_hash,claimedUser:row.consumed_user,joinedAt:row.joined_at});
  await db.query('UPDATE public.pilot_invitations SET history_recorded=true WHERE token_hash=$1',[row.token_hash]);
 }
}
