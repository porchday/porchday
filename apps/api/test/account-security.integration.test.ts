import {test,expect,vi,afterEach} from 'vitest';
import {Pool} from 'pg';
import {Hono} from 'hono';
import {hashPassword} from 'better-auth/crypto';
import {createOTP} from '@better-auth/utils/otp';
import {base32} from '@better-auth/utils/base32';
import {authRoutes} from '../src/auth-routes';
import type {Env,Variables} from '../src/types';
afterEach(()=>vi.restoreAllMocks());
const base=process.env.TEST_DATABASE_URL;
test.skipIf(!base)('MFA issues no session before second factor; backup codes and email-change links are single-use',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(!String(url).startsWith('https://api.pwnedpasswords.com/range/'))throw Error('Unexpected test network');return new Response('00000000000000000000000000000000000:0',{headers:{'content-type':'text/plain'}});});
 const owner=new Pool({connectionString:base});const id=crypto.randomUUID(),unique=id.replaceAll('-','');
 const email=unique+'@example.test',newEmail='new-'+email,password='test-only-strong-account-password';
 await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='porchday_security_test') THEN CREATE ROLE porchday_security_test LOGIN PASSWORD 'local-security-test' INHERIT; END IF; END $$");
 await owner.query('GRANT porchday_auth TO porchday_security_test');
 const runtime=new URL(base!);runtime.username='porchday_security_test';runtime.password='local-security-test';
 const emails:{to:string;text:string;subject:string}[]=[],pending:Promise<unknown>[]=[];
 const env={APP_URL:'http://localhost:5173',ENVIRONMENT:'development',SIGNUP_ENABLED:'false',HYPERDRIVE_AUTH:{connectionString:runtime.href},BETTER_AUTH_SECRET:'synthetic-test-key-more-than-thirty-two-characters',EMAIL:{send:async(m:unknown)=>{emails.push(m as typeof emails[number]);return {messageId:'synthetic'};}}} as unknown as Env;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();app.route('/api/auth',authRoutes);
 const context={waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext;
 const jar=new Map<string,string>();let calls=0;
 const call=async(path:string,body?:unknown)=>{
  const response=await app.fetch(new Request(env.APP_URL+'/api/auth/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:env.APP_URL,Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),'CF-Connecting-IP':unique+'-'+(++calls)},body:body?JSON.stringify(body):undefined}),env,context);
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');if(/Max-Age=0(?:;|$)/i.test(cookie))jar.delete(pair.slice(0,index));else jar.set(pair.slice(0,index),pair.slice(index+1));}
  return response;
 };
 try{
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,'s_'+unique.slice(0,15),email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'s_'+unique.slice(0,15)]);
  await owner.query('INSERT INTO public.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[crypto.randomUUID(),id,await hashPassword(password)]);
  expect((await call('sign-in/email',{email,password})).status).toBe(200);
  const enabled=await call('two-factor/enable',{password});expect(enabled.status).toBe(200);const setup=await enabled.json();
  expect(setup.backupCodes.length).toBeGreaterThan(0);
  const secret=new URL(setup.totpURI).searchParams.get('secret')!;
  expect((await call('two-factor/verify-totp',{code:await createOTP(new TextDecoder().decode(base32.decode(secret))).totp(),trustDevice:false})).status).toBe(200);
  await call('sign-out',{});jar.clear();
  const first=await call('sign-in/email',{email,password});expect((await first.json()).twoFactorRedirect).toBe(true);
  expect((await call('get-session')).status).toBe(200);expect(await (await call('get-session')).json()).toBeNull();
  expect((await call('two-factor/verify-backup-code',{code:setup.backupCodes[0],trustDevice:false})).status).toBe(200);
  expect((await (await call('get-session')).json()).user.id).toBe(id);
  await call('sign-out',{});jar.clear();await call('sign-in/email',{email,password});
  expect((await call('two-factor/verify-backup-code',{code:setup.backupCodes[0],trustDevice:false})).status).toBeGreaterThanOrEqual(400);
  expect((await call('two-factor/verify-backup-code',{code:setup.backupCodes[1],trustDevice:false})).status).toBe(200);
  expect((await call('change-email',{newEmail,callbackURL:env.APP_URL+'/login'})).status).toBe(200);
  const oldApproval=emails.find(e=>e.subject==='Confirm a Porchday email change')!;expect(oldApproval.to).toBe(email);
  const firstUrl=new URL(oldApproval.text.match(/http:\/\/localhost:5173\/api\/auth\/verify-email\?\S+/)![0]);
  expect((await call('verify-email'+firstUrl.search)).status).toBeLessThan(400);
  expect((await owner.query('SELECT email FROM public.auth_user WHERE id=$1',[id])).rows[0].email).toBe(email);
  const newVerification=emails.find(e=>e.to===newEmail)!;expect(newVerification).toBeTruthy();
  const secondUrl=new URL(newVerification.text.match(/http:\/\/localhost:5173\/api\/auth\/verify-email\?\S+/)![0]);
  expect((await call('verify-email'+secondUrl.search)).status).toBeLessThan(400);
  expect((await owner.query('SELECT email FROM public.auth_user WHERE id=$1',[id])).rows[0].email).toBe(newEmail);
  expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[id])).rowCount).toBe(0);
  expect((await call('verify-email'+secondUrl.search)).status).toBe(400);
 }finally{await Promise.allSettled(pending);await owner.query('DELETE FROM public.auth_user WHERE id=$1',[id]);await owner.query('DELETE FROM app.members WHERE id=$1',[id]);await owner.end();}
},30000);
