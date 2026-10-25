import { Hono } from 'hono';
import {bodyLimit} from 'hono/body-limit';
import { authPool, createAuth, hashToken } from './auth';
import type { Env, Variables } from './types';
import { event } from './telemetry';
import {jwtVerify,decodeJwt} from 'jose';
import type {Pool} from 'pg';
import {sendAccountEmail} from './email';

export const authRoutes = new Hono<{Bindings:Env;Variables:Variables}>();
authRoutes.use('*',bodyLimit({maxSize:16384,onError:c=>c.json({error:{code:'TOO_LARGE'}},413)}));
const allowed = new Set(['sign-in/email','sign-up/email','sign-out','get-session','verify-email','request-password-reset','reset-password','send-verification-email','change-password','list-sessions','revoke-session','revoke-sessions','revoke-other-sessions','change-email','two-factor/enable','two-factor/disable','two-factor/verify-totp','two-factor/verify-backup-code','two-factor/generate-backup-codes']);

authRoutes.all('/*',async c => {
 const path=new URL(c.req.url).pathname.replace('/api/auth/','');
 if(!allowed.has(path) && !(c.req.method==='GET' && /^reset-password\/[A-Za-z0-9_-]{16,200}$/.test(path))) return c.json({error:{code:'NOT_FOUND',message:'This sign-in method is not enabled.'}},404);
 const physicalPool=authPool(c.env),client=await physicalPool.connect();
 // One explicit transaction pins Hyperdrive to one connection. Library subtransactions
 // are disabled only for this bound adapter; no session-scoped identity or lock escapes.
 const proxyClient={query:client.query.bind(client),release:()=>{}};
 const pool={query:client.query.bind(client),connect:async()=>proxyClient,end:async()=>{}} as unknown as Pool;
 let failed=false;
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  const ip=c.req.header('CF-Connecting-IP') || 'local';
  const key=await hashToken(c.env.BETTER_AUTH_SECRET+'|'+ip+'|'+path);
  const limited=await pool.query(`INSERT INTO public.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 minute')
   ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END,
   expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE auth_rate_limits.expires_at END RETURNING count`,[key]);
  if(limited.rows[0].count> (path==='get-session'?60:10))return c.json({error:{code:'RATE_LIMIT',message:'Please wait a minute and try again.'}},429);
  let request=c.req.raw;
  // Serialize credentials and login issuance with reviewed recovery for this identity.
  // Unverified cookie/claim hints below select a lock only; Better Auth still validates them.
  let memberToLock:string|undefined;
  const incoming=(request.method==='POST'?await request.clone().json().catch(()=>({})): {}) as Record<string,unknown>;
  if(typeof incoming.email==='string')memberToLock=(await pool.query('SELECT id FROM public.auth_user WHERE lower(email)=$1',[incoming.email.toLowerCase()])).rows[0]?.id;
  if(path==='verify-email'){
   try{const claims=decodeJwt(new URL(request.url).searchParams.get('token')||'');if(typeof claims.email==='string')memberToLock=(await pool.query('SELECT id FROM public.auth_user WHERE email=$1',[claims.email])).rows[0]?.id;}catch{}
  }
  if(path==='reset-password'&&typeof incoming.token==='string')memberToLock=(await pool.query('SELECT value AS id FROM public.auth_verification WHERE identifier=$1',[await hashToken('reset-password:'+incoming.token)])).rows[0]?.id;
  if(!memberToLock){
   const existing=await createAuth(c.env,pool,undefined,true).api.getSession({headers:request.headers});memberToLock=existing?.user.id;
  }
  if(!memberToLock&&path.startsWith('two-factor/')){
   const raw=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>/^(__Secure-)?better-auth\.two_factor=/.test(v));
   if(raw){let hint='';try{hint=decodeURIComponent(raw.slice(raw.indexOf('=')+1)).split('.')[0];}catch{}if(/^2fa-[A-Za-z0-9]+$/.test(hint))memberToLock=(await pool.query('SELECT value AS id FROM public.auth_verification WHERE identifier=$1',[await hashToken(hint)])).rows[0]?.id;}
  }
  if(memberToLock&&/^[a-f0-9-]{36}$/i.test(memberToLock))await pool.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[memberToLock]);
  let signupId:string|undefined;
  if(path==='sign-up/email') {
   if(c.env.SIGNUP_ENABLED!=='true')return c.json({error:{code:'PILOT_CLOSED',message:'Pilot registration is not open yet.'}},403);
   if(request.method!=='POST')return c.json({error:{code:'METHOD_NOT_ALLOWED'}},405);
   const b=await request.clone().json() as Record<string,unknown>;
   if(b.adult!==true||b.acceptedRules!==true)return c.json({error:{code:'ELIGIBILITY_REQUIRED',message:'The pilot is for adults who accept the community rules.'}},400);
   const handle=String(b.handle||'').toLowerCase().trim();
   const email=String(b.email||'').toLowerCase().trim();
   if(!/^[a-z0-9_]{3,24}$/.test(handle)||!email.includes('@')||String(b.inviteCode||'').length<24)return c.json({error:{code:'INVALID_INVITATION',message:'Check your invitation, email and handle.'}},400);
   signupId=crypto.randomUUID();
   const claim=await pool.query(`UPDATE public.pilot_invitations SET consumed_user=$1,handle=$2,claimed_at=now(),adult_attested_at=now(),rules_accepted_at=now()
    WHERE token_hash=$3 AND email=$4 AND expires_at>now() AND consumed_user IS NULL RETURNING token_hash`,[signupId,handle,await hashToken(String(b.inviteCode)),email]);
   if(!claim.rowCount)return c.json({error:{code:'INVALID_INVITATION',message:'This invitation is invalid, expired, or already used.'}},403);
   request=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({email,password:b.password,name:handle,callbackURL:c.env.APP_URL+'/login?verified=1'})});
  }
  let changedEmailUser:{id:string;email:string}|undefined;
  if(path==='verify-email') {
   const token=new URL(request.url).searchParams.get('token');
   if(!token)return c.json({error:{code:'INVALID_LINK'}},400);
   let claims;
   try{claims=(await jwtVerify(token,new TextEncoder().encode(c.env.BETTER_AUTH_SECRET),{algorithms:['HS256'],requiredClaims:['iat','exp']})).payload;}
   catch{return c.json({error:{code:'INVALID_LINK'}},400);}
   const account=await pool.query('SELECT id,email,credentials_changed_at,app.auth_member_status(id::uuid) AS status FROM public.auth_user WHERE email=$1',[claims.email]);
   if(!account.rows[0] || ['hold','suspended','deleted'].includes(account.rows[0].status) || (account.rows[0].credentials_changed_at && Number(claims.iat)<=Math.floor(new Date(account.rows[0].credentials_changed_at).getTime()/1000)))return c.json({error:{code:'INVALID_LINK'}},400);
   if(claims.requestType==='change-email-verification')changedEmailUser=account.rows[0];
   const inserted=await pool.query("INSERT INTO public.used_email_links(token_hash,expires_at) VALUES($1,now()+interval '2 hours') ON CONFLICT DO NOTHING RETURNING token_hash",[await hashToken(token)]);
   if(!inserted.rowCount)return c.json({error:{code:'LINK_ALREADY_USED'}},400);
  }
  if(path==='reset-password' && request.method==='POST') {
   const b=await request.clone().json() as {token?:string};
   const token=b.token||new URL(request.url).searchParams.get('token');
   if(token){
    const status=await pool.query("SELECT app.auth_member_status(value::uuid) AS status FROM public.auth_verification WHERE identifier=$1 AND \"expiresAt\">now()",[await hashToken('reset-password:'+token)]);
    if(status.rows.some(r=>['hold','deleted','suspended'].includes(r.status)))return c.json({error:{code:'ACCOUNT_UNAVAILABLE'}},403);
   }
  }
  const auth=createAuth(c.env,pool,signupId,true);
  if(['change-password','change-email','revoke-session','revoke-sessions','revoke-other-sessions','two-factor/enable','two-factor/disable','two-factor/generate-backup-codes'].includes(path)){
   const session=await auth.api.getSession({headers:request.headers});
   if(session){
    if(Date.now()-new Date(session.session.createdAt).getTime()>15*60_000)return c.json({error:{code:'RECENT_AUTH_REQUIRED'}},403);
    const status=await pool.query('SELECT app.auth_member_status($1::uuid) AS status',[session.user.id]);
    if(status.rows.some(r=>['hold','deleted','suspended'].includes(r.status)))return c.json({error:{code:'ACCOUNT_UNAVAILABLE'}},403);
   }
  }
  if(path==='change-password'&&request.method==='POST')request=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...incoming,revokeOtherSessions:true})});
  const response=await auth.handler(request);
  if(path==='change-password'&&response.ok&&memberToLock){
   await pool.query('DELETE FROM public.auth_session WHERE "userId"=$1',[memberToLock]);
   await pool.query('DELETE FROM public.auth_verification WHERE value=$1',[memberToLock]);
   await pool.query('UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1',[memberToLock]);
   const user=(await pool.query('SELECT email FROM public.auth_user WHERE id=$1',[memberToLock])).rows[0];
   if(user)c.executionCtx.waitUntil(sendAccountEmail(c.env,user.email,'Your Porchday password changed',`Your password changed and previous login sessions were revoked. Sign in again. If this was not you, report it at ${c.env.APP_URL}/recovery.`).catch(()=>{}));
  }
  if(changedEmailUser && response.status<400){
   const current=await pool.query('SELECT email FROM public.auth_user WHERE id=$1',[changedEmailUser.id]);
   if(current.rows[0]?.email!==changedEmailUser.email){
    await pool.query('DELETE FROM public.auth_session WHERE "userId"=$1',[changedEmailUser.id]);
    await pool.query('DELETE FROM public.auth_verification WHERE value=$1',[changedEmailUser.id]);
    await pool.query('UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1',[changedEmailUser.id]);
    for(const address of [changedEmailUser.email,current.rows[0].email])c.executionCtx.waitUntil(sendAccountEmail(c.env,address,'Your Porchday email changed',`Your login email changed. Sign in again using the verified new address. If you did not authorize this, report a stolen account at ${c.env.APP_URL}/recovery.`).catch(()=>{}));
   }
  }
  if(signupId && !response.ok) {
   // A downstream email failure can occur after the account exists. Never reissue that claim.
   await pool.query(`UPDATE public.pilot_invitations SET consumed_user=NULL,handle=NULL,claimed_at=NULL,adult_attested_at=NULL,rules_accepted_at=NULL
    WHERE consumed_user=$1 AND NOT EXISTS(SELECT 1 FROM public.auth_user WHERE id=$1)`,[signupId]);
  }
  return response;
 } catch {
  failed=true;
  event('error',{code:'auth_failed',environment:c.env.ENVIRONMENT});
  return c.json({error:{code:'AUTH_UNAVAILABLE',message:'Account services are temporarily unavailable. Please try again.'}},503);
 } finally {try{await client.query(failed?'ROLLBACK':'COMMIT');}finally{client.release();c.executionCtx.waitUntil(physicalPool.end());}}
});
