import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './auth-routes';
import recoveryRoutes,{createStaffRecoveryRoutes} from './recovery';
import {requireStaff} from './staff';
import { requireMember,requireAppealMember } from './session';
import {createModerationRoutes,createAppealRoutes} from './moderation';
import { createSocialRoutes } from './social';
import {createIntegrationConsentRoutes,createIntegrationTokenRoutes} from './social-integrations';
import { cleanupExpired, withMember } from './db';
import { authPool } from './auth';
import { event,normalizedRoute } from './telemetry';
import type {Env,Variables} from './types';
import {cleanupDeletedIdentities} from './identity-cleanup';
import {cleanupAuthenticationMetadata} from './metadata-cleanup';
import {processWebPush} from './social-push';
import {processAccountEmails} from './email-outbox';
import {processNativePush} from './social-native-push';
import {privacyReadGuard,privacyMutationMiddleware,withPrivacyJournal} from './privacy-journal';
import {requireOperations,readOperationalHealth,recordCleanupSuccess} from './operations-health';

const app=new Hono<{Bindings:Env;Variables:Variables}>();
app.use('*',secureHeaders({
 contentSecurityPolicy:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'blob:','data:'],fontSrc:["'self'"],connectSrc:["'self'"],workerSrc:["'self'",'blob:'],objectSrc:["'none'"],baseUri:["'none'"],formAction:["'self'"],frameAncestors:["'none'"]},
 referrerPolicy:'no-referrer',xFrameOptions:'DENY',permissionsPolicy:{camera:[],microphone:[],geolocation:[]},
}));
app.use('/api/*',bodyLimit({maxSize:25*1024*1024,onError:c=>c.json({error:{code:'TOO_LARGE',message:'This upload is too large.'}},413)}));
app.use('*',async(c,next)=>{
 const start=Date.now();c.set('requestId',crypto.randomUUID());
 await next();
 if(c.req.path.startsWith('/api/'))c.header('Cache-Control','private, no-store');
 c.header('X-Request-ID',c.get('requestId'));
 event('request',{route:normalizedRoute(c.req.path),method:c.req.method,status:c.res.status,durationMs:Date.now()-start,environment:c.env.ENVIRONMENT});
});
app.use('/api/*',async(c,next)=>{
 if(!['GET','HEAD','OPTIONS'].includes(c.req.method) && c.req.path!=='/api/integration/token'){
  const origin=c.req.header('Origin');
  if(origin!==c.env.APP_URL)return c.json({error:{code:'ORIGIN_DENIED',message:'This request could not be verified.'}},403);
 }
 await next();
});
app.get('/health',c=>c.json({status:'ok',service:'porchday',environment:c.env.ENVIRONMENT,release:c.env.CF_VERSION_METADATA?.id||'local'}));
app.get('/.well-known/apple-app-site-association',c=>{
 const team=c.env.APNS_TEAM_ID,bundle=c.env.APNS_BUNDLE_ID;
 if(!team||!/^[A-Z0-9]{10}$/.test(team)||!bundle||!/^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(bundle))return c.json({error:{code:'NOT_CONFIGURED'}},404);
 c.header('Cache-Control','public, max-age=3600');
 return c.json({applinks:{details:[{appIDs:[team+'.'+bundle],components:[{'/':'/app/post/*',comment:'Open a Porchday post in the signed native app.'}]}]}});
});
app.get('/api/operations/health',requireOperations,privacyReadGuard,async c=>{
 const result=await readOperationalHealth(c.env);
 return c.json(result,result.status==='ok'?200:503);
});
app.use('/api/*',privacyReadGuard);
app.route('/api/auth',authRoutes);
app.route('/api/account-recovery',recoveryRoutes);
app.use('/api/staff/recovery/*',requireStaff('recovery'));
app.use('/api/staff/recovery/*',privacyMutationMiddleware);
app.route('/api/staff/recovery',createStaffRecoveryRoutes());
app.use('/api/staff/moderation/*',requireStaff('moderation'));
app.use('/api/staff/moderation/*',privacyMutationMiddleware);
app.route('/api/staff/moderation',createModerationRoutes());
app.use('/api/member-appeals/*',requireAppealMember);
app.route('/api/member-appeals',createAppealRoutes());
app.route('/api/integration',createIntegrationTokenRoutes());
app.use('/api/v1/*',requireMember);
app.use('/api/v1/*',privacyMutationMiddleware);
app.delete('/api/v1/account',async c=>{
 if(Date.now()-c.get('authTime')>15*60_000)return c.json({error:{code:'RECENT_AUTH_REQUIRED'}},403);
 const body=await c.req.json();if(body.confirm!=='DELETE')return c.json({error:{code:'CONFIRMATION_REQUIRED'}},400);
 try { await withMember(c.env,c.get('memberId'),db=>db`select app.delete_member()`); }
 catch(error){if((error as Error).message.includes('OWNED_GROUPS'))return c.json({error:{code:'OWNED_GROUPS',message:'Transfer ownership or delete your groups first.'}},409);throw error;}
 const pool=authPool(c.env);
 try {await pool.query('DELETE FROM public.auth_user WHERE id=$1',[c.get('memberId')]);return c.json({ok:true});}
 finally{c.executionCtx.waitUntil(pool.end());}
});
app.route('/api/v1',createSocialRoutes());
app.route('/api/v1',createIntegrationConsentRoutes());
app.all('/api/*',c=>c.json({error:{code:'NOT_FOUND'}},404));
app.get('*',c=>c.env.ASSETS.fetch(c.req.raw));
app.onError((_error,c)=>{event('error',{code:'request_failed',environment:c.env.ENVIRONMENT});return c.json({error:{code:'SERVICE_UNAVAILABLE',message:'Please try again shortly.'}},503);});

export { app };
export default {
 fetch:app.fetch,
 async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){
  ctx.waitUntil(env.JOBS.send({kind:'expiry'}));
 },
 async queue(batch:MessageBatch<{kind:string;id?:string}>,env:Env){
  try {
   const results=await withPrivacyJournal(env,async()=>{
    const expired=await cleanupExpired(env);
    await cleanupDeletedIdentities(env);
    await cleanupAuthenticationMetadata(env);
    return expired;
   });
   await processWebPush(env);
   await processNativePush(env);
   await processAccountEmails(env);
   await recordCleanupSuccess(env);
   event('job',{code:'cleanup_complete',count:results.deleted_objects,environment:env.ENVIRONMENT});
   batch.ackAll();
  }catch{event('error',{code:'cleanup_retry',environment:env.ENVIRONMENT});batch.retryAll({delaySeconds:60});}
 }
} satisfies ExportedHandler<Env,{kind:string;id?:string}>;
