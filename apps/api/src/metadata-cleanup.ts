import {authPool} from './auth';
import type {Env} from './types';
import {captureLegacyInvitations} from './invitation-history';
/** Bounded retention sweeps. No contact addresses or case details enter telemetry. */
export async function cleanupAuthenticationMetadata(env:Env){
 const pool=authPool(env);
 try{
  const client=await pool.connect();
  try{await client.query('BEGIN');await captureLegacyInvitations(client,env);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
  await pool.query('SELECT app.process_invitation_joined_notices()');
  await pool.query('DELETE FROM public.auth_rate_limits WHERE key IN(SELECT key FROM public.auth_rate_limits WHERE expires_at<now() LIMIT 1000)');
  await pool.query('DELETE FROM public.used_email_links WHERE token_hash IN(SELECT token_hash FROM public.used_email_links WHERE expires_at<now() LIMIT 1000)');
  await pool.query('DELETE FROM public.auth_verification WHERE id IN(SELECT id FROM public.auth_verification WHERE "expiresAt"<now() LIMIT 1000)');
  await pool.query('DELETE FROM public.auth_session WHERE id IN(SELECT id FROM public.auth_session WHERE "expiresAt"<now() LIMIT 1000)');
  await pool.query("DELETE FROM public.pilot_invitations WHERE token_hash IN(SELECT token_hash FROM public.pilot_invitations WHERE expires_at<now() AND (sender_id IS NULL OR history_recorded OR created_at<=now()-interval '90 days') LIMIT 1000)");
  await pool.query("DELETE FROM public.platform_invitation_history WHERE id IN(SELECT id FROM public.platform_invitation_history WHERE requested_at<=now()-interval '90 days' LIMIT 1000)");
  await pool.query("DELETE FROM public.platform_invitation_requests WHERE id IN(SELECT id FROM public.platform_invitation_requests WHERE created_at<now()-interval '7 days' LIMIT 1000)");
  await pool.query('DELETE FROM public.recovery_cases WHERE id IN(SELECT id FROM public.recovery_cases WHERE retention_until<now() LIMIT 100)');
  await pool.query('DELETE FROM public.security_contact_history WHERE id IN(SELECT id FROM public.security_contact_history WHERE retention_until<now() LIMIT 1000)');
 }finally{await pool.end();}
}
