import {phaseTiming} from './request-timing';
import { createMiddleware } from 'hono/factory';
import { authPool,createAuth } from './auth';
import type {Env,Variables} from './types';
import {measureFeedPhase} from './feed-timing';
export type PreparedMemberAuth = {pool: ReturnType<typeof authPool>; auth: ReturnType<typeof createAuth>; ready: Promise<void>};
/** Only read-only schema validation starts early. Session lookup/renewal and
 * current account status remain behind the fresh privacy guard. Request-local. */
export const prepareMemberAuth=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
 if(c.req.method!=='GET'||c.req.path!=='/api/v1/me')return next();
 const pool=authPool(c.env),auth=createAuth(c.env,pool),started=performance.now();
 const ready=auth.$context.then(async context=>{await context.checkSchema?.();})
  .finally(()=>c.get('requestTiming')?.record('auth_schema',performance.now()-started));
 void ready.catch(()=>{}); // Observe early rejection while the journal is still pending.
 c.set('preparedMemberAuth',{pool,auth,ready});
 try{await next();}
 finally{c.executionCtx.waitUntil(ready.catch(()=>{}).then(()=>pool.end()));}
});
export const requireMember=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
 const prepared=c.get('preparedMemberAuth');
 const pool=prepared?.pool??authPool(c.env);
 const timing=phaseTiming(c);
 try {
  const session=await measureFeedPhase(timing,'auth_session',async()=>{await prepared?.ready;return (prepared?.auth??createAuth(c.env,pool)).api.getSession({headers:c.req.raw.headers});});
  if(!session?.user.emailVerified)return c.json({error:{code:'UNAUTHORIZED',message:'Sign in with a verified account.'}},401);
  const {rows}=await measureFeedPhase(timing,'auth_status',()=>pool.query('SELECT app.auth_member_status($1::uuid) AS status',[session.user.id]));
  const dataOnly = (c.req.method==='GET' && (/^\/api\/v1\/(me|devices|keys\/backup|owned-groups|emoji-library)$/.test(c.req.path)||/^\/api\/v1\/devices\/[a-f0-9-]{36}$/.test(c.req.path)))
   || /^\/api\/v1\/exports(?:\/|$)/.test(c.req.path)
   || (c.req.method==='DELETE' && (c.req.path==='/api/v1/account'||/^\/api\/v1\/groups\/[a-f0-9-]{36}$/.test(c.req.path)));
  if(!rows[0]?.status || ['hold','deleting','deleted','security_hold'].includes(rows[0].status) || (rows[0].status==='suspended'&&!dataOnly))return c.json({error:{code:'ACCOUNT_UNAVAILABLE',message:'This account is unavailable. Recovery and appeals remain available.'}},403);
  c.set('memberId',session.user.id);c.set('sessionId',session.session.id);c.set('authTime',new Date(session.session.createdAt).getTime());
  await next();
 } finally {if(!prepared)c.executionCtx.waitUntil(pool.end());}
});

// Suspended accounts have a separate, narrowly scoped appeal channel.
export const requireAppealMember=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
 const pool=authPool(c.env);
 try{
  const session=await createAuth(c.env,pool).api.getSession({headers:c.req.raw.headers});
  if(!session?.user.emailVerified)return c.json({error:{code:'UNAUTHORIZED'}},401);
  const {rows}=await pool.query('SELECT app.auth_member_status($1::uuid) AS status',[session.user.id]);
  if(!rows[0]?.status||['hold','deleting','deleted'].includes(rows[0].status))return c.json({error:{code:'ACCOUNT_UNAVAILABLE'}},403);
  c.set('memberId',session.user.id);c.set('sessionId',session.session.id);c.set('authTime',new Date(session.session.createdAt).getTime());
  await next();
 }finally{c.executionCtx.waitUntil(pool.end());}
});
