import {test,expect,vi,afterEach} from 'vitest';
afterEach(()=>vi.restoreAllMocks());
import {Pool} from 'pg';
import {app} from '../src/index';
import {hashToken} from '../src/auth';
import type {Env} from '../src/types';
const base=process.env.TEST_DATABASE_URL;
test.skipIf(!base)('full app gates invitations, one-use verification, origins, sessions and takeover holds',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(!String(url).startsWith('https://api.pwnedpasswords.com/range/'))throw Error('Unexpected test network');return new Response('00000000000000000000000000000000000:0',{headers:{'content-type':'text/plain'}});});
 const pool=new Pool({connectionString:base});
 const emails:{text:string}[]=[];const pending:Promise<unknown>[]=[];
 const url=new URL(base!);url.username='porchday_auth_boundary_test';url.password='local-boundary-test';
 await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='porchday_auth_boundary_test') THEN CREATE ROLE porchday_auth_boundary_test LOGIN PASSWORD 'local-boundary-test' INHERIT; END IF; END $$");
 await pool.query('GRANT porchday_auth TO porchday_auth_boundary_test');
 const env={APP_URL:'http://localhost:5173',ENVIRONMENT:'development',SIGNUP_ENABLED:'true',BETTER_AUTH_SECRET:'local-test-secret-longer-than-thirty-two-characters',EMAIL_FROM:'accounts@porchday.com',HYPERDRIVE_AUTH:{connectionString:url.href},HYPERDRIVE_SOCIAL:{connectionString:base},EMAIL:{send:async(m:unknown)=>{emails.push(m as {text:string});return {messageId:'synthetic'};}},ASSETS:{fetch:async()=>new Response('local')}} as unknown as Env;
 const context={waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext;
 const call=(path:string,method='GET',body?:unknown,cookie?:string,origin=env.APP_URL)=>app.fetch(new Request(env.APP_URL+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),env,context);
 const unique=crypto.randomUUID().replaceAll('-',''),email=unique+'@example.test',handle='test_'+unique.slice(0,15),token=crypto.randomUUID()+crypto.randomUUID();let userId:string|undefined;
 try{
  const body={email,handle,name:handle,password:'very-long-synthetic-password',adult:true,acceptedRules:true,inviteCode:token};
  expect((await call('/api/auth/sign-up/email','POST',body)).status).toBe(403);
  await pool.query("INSERT INTO public.pilot_invitations(token_hash,email,expires_at) VALUES($1,$2,now()+interval '1 hour')",[await hashToken(token),email]);
  expect((await call('/api/auth/sign-up/email','POST',{...body,adult:false})).status).toBe(400);
  const created=await call('/api/auth/sign-up/email','POST',body);expect(created.status).toBe(200);
  userId=(await created.json() as {user:{id:string}}).user.id;
  expect((await call('/api/auth/sign-in/email','POST',{email,password:body.password})).status).toBe(403);
  const verification=emails[0].text.match(/http:\/\/localhost:5173\/api\/auth\/verify-email\?\S+/)![0];
  const first=await call(new URL(verification).pathname+new URL(verification).search);expect(first.status).toBeLessThan(400);
  expect((await call(new URL(verification).pathname+new URL(verification).search)).status).toBe(400);
  const login=await call('/api/auth/sign-in/email','POST',{email,password:body.password});expect(login.status).toBe(200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  expect((await call('/api/auth/get-session','GET',undefined,cookie)).status).toBe(200);
  expect((await call('/api/v1/me')).status).toBe(401);
  expect((await call('/api/auth/change-password','POST',{currentPassword:body.password,newPassword:'different-long-test-password'},cookie,'https://hostile.example')).status).toBe(403);
  expect((await call('/api/auth/sign-in/social','POST',{})).status).toBe(404);
  await pool.query('SELECT app.set_security_hold($1::uuid)',[userId]);
  expect((await call('/api/v1/me','GET',undefined,cookie)).status).toBe(403);
  expect((await call('/api/auth/sign-in/email','POST',{email,password:body.password})).status).toBeGreaterThanOrEqual(400);
 }finally{
  await Promise.allSettled(pending);
  if(userId){await pool.query('DELETE FROM public.auth_user WHERE id=$1',[userId]);await pool.query('DELETE FROM app.members WHERE id=$1',[userId]);}
  await pool.query('DELETE FROM public.pilot_invitations WHERE email=$1',[email]);await pool.end();
 }
},30000);
