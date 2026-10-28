import {sessionDenialAuth} from './session-denial-auth';
import { betterAuth } from 'better-auth';
import {twoFactor,haveIBeenPwned} from 'better-auth/plugins';
import {PostgresDialect} from 'kysely';
import { Pool } from 'pg';
import type { Env } from './types';
import { sendAccountEmail } from './email';
import {enqueueAccountEmail} from './email-outbox';

export function createAuth(env: Env, pool: Pool, signupId?: string, inTransaction=false, validateSchema=true) {
  const accountEmail=(memberId:string,to:string,subject:string,text:string)=>inTransaction
    ? enqueueAccountEmail(env,pool,memberId,to,subject,text)
    : sendAccountEmail(env,to,subject,text);
  return betterAuth({
    appName: 'Porchday', baseURL: env.APP_URL, basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET, database: inTransaction ? {dialect:new PostgresDialect({pool}),type:'postgres',transaction:false} : pool,
    trustedOrigins: [env.APP_URL],
    advanced: {
      database: { validateSchema, joins:true, generateId: ({model}) => model === 'user' && signupId ? signupId : crypto.randomUUID() },
      useSecureCookies: env.APP_URL.startsWith('https:'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      disableOriginCheck: false,
    },
    user: { modelName:'auth_user', deleteUser: { enabled: false }, changeEmail: {
      enabled:true, updateEmailWithoutVerification:false,
      sendChangeEmailConfirmation:async({user,url})=>{
        await accountEmail(user.id,user.email,'Confirm a Porchday email change',`Someone requested a change to your account email. Approve this request first, then verify the new address:\n\n${url}\n\nIf this was not you, report it at ${env.APP_URL}/recovery. Never forward this link.`);
      },
    } },
    plugins:[sessionDenialAuth(env),haveIBeenPwned(),twoFactor({issuer:'Porchday',twoFactorTable:'auth_two_factor',skipVerificationOnEnable:false,accountLockout:{enabled:true,maxFailedAttempts:5,durationSeconds:900}})],
    session: { modelName:'auth_session', expiresIn:60*60*24*7, updateAge:60*60*24, freshAge:60*15, cookieCache:{enabled:false} },
    account: { modelName:'auth_account', accountLinking:{enabled:false} },
    verification: { modelName:'auth_verification', storeIdentifier:{hash:hashToken} },
    emailAndPassword: {
      enabled:true, requireEmailVerification:true, minPasswordLength:12, maxPasswordLength:128,
      autoSignIn:false, revokeSessionsOnPasswordReset:true,
      sendResetPassword: async ({user,url}) => {
        await accountEmail(user.id,user.email,'Reset your Porchday password',`Someone requested a password reset for your Porchday account.\n\n${url}\n\nThis link expires shortly and can be used only once. Resetting your login password does not unlock encrypted history. If this was not you, ignore this message or visit ${env.APP_URL}/recovery.`);
      },
      onPasswordReset: async ({user}) => {
        await pool.query('UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1',[user.id]);
        await pool.query('DELETE FROM public.auth_verification WHERE value=$1',[user.id]);
        await accountEmail(user.id,user.email,'Your Porchday password changed',`Your login password was reset. Existing sessions have been revoked. If you did not do this, report a stolen account at ${env.APP_URL}/recovery.`);
      },
    },
    emailVerification: {
      sendOnSignUp:true, sendOnSignIn:true, autoSignInAfterVerification:false, expiresIn:3600,
      sendVerificationEmail: async ({user,url}) => {
        await accountEmail(user.id,user.email,'Verify your Porchday email',`Welcome to Porchday. Verify your email using this link:\n\n${url}\n\nIf you did not request an account, ignore this message.`);
      },
    },
    rateLimit: { enabled:false }, // Durable, hashed-identifier rate limits are applied outside this handler.
    logger: { disabled:true },
    databaseHooks: {
      session: { create: { before: async session => {
        const status=await pool.query('SELECT app.auth_member_status($1::uuid) AS status',[session.userId]);
        return status.rows[0]?.status && !['hold','deleted','deleting'].includes(status.rows[0].status) ? {data:session} : false;
      } } },
      user: { create: { before: async user => {
        if (!signupId) return false;
        const result = await pool.query('SELECT 1 FROM public.pilot_invitations WHERE consumed_user=$1 AND email=$2 AND expires_at>now()', [signupId,user.email.toLowerCase()]);
        return result.rowCount ? {data:{...user,id:signupId}} : false;
      }, after: async user => {
        const invitation = await pool.query('SELECT handle FROM public.pilot_invitations WHERE consumed_user=$1',[user.id]);
        if (!invitation.rows[0]?.handle) throw new Error('INVITATION_REQUIRED');
        await pool.query('SELECT app.auth_provision_member($1::uuid,$2::text)',[user.id,invitation.rows[0].handle]);
      } } },
    },
  });
}
export function authPool(env: Env): Pool {
  return new Pool({connectionString: env.HYPERDRIVE_AUTH.connectionString, max:3, connectionTimeoutMillis:10000, idleTimeoutMillis:1000});
}
export async function hashToken(value: string): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
