import {test,expect,vi,afterEach} from 'vitest';
afterEach(()=>vi.restoreAllMocks());
import {Pool} from 'pg';
import {Hono} from 'hono';
import {hashPassword,verifyPassword} from 'better-auth/crypto';
import recoveryRoutes,{createStaffRecoveryRoutes} from '../src/recovery';
import type {Env,Variables} from '../src/types';
const base=process.env.TEST_DATABASE_URL;
test.skipIf(!base)('recovery requires verified contact, corroborated hold and two distinct reviewers; revokes old access and consumes restore link',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(!String(url).startsWith('https://api.pwnedpasswords.com/range/'))throw Error('Unexpected test network');return new Response('00000000000000000000000000000000000:0',{headers:{'content-type':'text/plain'}});});
 const owner=new Pool({connectionString:base});const unique=crypto.randomUUID().replaceAll('-','');
 const id=crypto.randomUUID(),oldEmail=unique+'@example.test',safeEmail='safe-'+unique+'@example.test',handle='r_'+unique.slice(0,15);
 const a='review-a-'+unique,b='review-b-'+unique;
 const emails:{to:string;text:string}[]=[],pending:Promise<unknown>[]=[];
 const runtime=new URL(base!);runtime.username='porchday_recovery_test';runtime.password='local-recovery-test';
 await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='porchday_recovery_test') THEN CREATE ROLE porchday_recovery_test LOGIN PASSWORD 'local-recovery-test' INHERIT; END IF; END $$");
 await owner.query('GRANT porchday_auth TO porchday_recovery_test');
 const env={HYPERDRIVE_AUTH:{connectionString:runtime.href},APP_URL:'http://localhost:5173',BETTER_AUTH_SECRET:'synthetic-test-key-more-than-thirty-two-characters',EMAIL:{send:async(m:unknown)=>{emails.push(m as {to:string;text:string});return {messageId:'synthetic'};}}} as unknown as Env;
 const ctx={waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext;
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.route('/public',recoveryRoutes);
 // Test-only authentication shim. Production mounts requireStaff with signed Access JWTs.
 app.use('/staff/*',async(c,next)=>{c.set('staffSubject',c.req.header('X-Test-Staff')||'unauthorized');await next();});
 app.route('/staff',createStaffRecoveryRoutes());
 const call=(path:string,body?:unknown,staff?:string,bearer?:string)=>app.fetch(new Request('http://localhost:5173'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','CF-Connecting-IP':unique,...(staff?{'X-Test-Staff':staff}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body?JSON.stringify(body):undefined}),env,ctx);
 let caseId:string|undefined;
 try{
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,handle,oldEmail]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,handle]);
  await owner.query('INSERT INTO public.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[crypto.randomUUID(),id,await hashPassword('synthetic-old-password-123')]);
  await owner.query('INSERT INTO public.auth_session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 day\')',[crypto.randomUUID(),crypto.randomUUID(),id]);
  for(const subject of [a,b])await owner.query('INSERT INTO public.staff_users(subject,email,roles) VALUES($1,$2,ARRAY[\'recovery\'])',[subject,subject+'@example.test']);
  expect((await call('/public/reports',{accountReference:handle,safeEmail,description:'Existing account history evidence',trustedMethod:'Previous verified email'})).status).toBe(202);
  expect((await owner.query('SELECT status FROM app.members WHERE id=$1',[id])).rows[0].status).toBe('active');
  const contactToken=emails[0].text.match(/#token=([a-f0-9]{64})/)![1];
  const verification=await call('/public/verify-contact',{token:contactToken});expect(verification.status).toBe(200);
  const data=await verification.json();caseId=data.caseId;
  expect((await call('/public/verify-contact',{token:contactToken})).status).toBe(400);
  expect((await call('/public/case')).status).toBe(401);
  expect((await call('/public/case',undefined,undefined,data.recoverySession)).status).toBe(200);
  expect((await call('/public/evidence',{description:'Reference to prior confirmed security event.'},undefined,data.recoverySession)).status).toBe(200);
  const review={evidenceReference:'Established method independently checked: synthetic history event',reason:'Corroborated loss of established account access.'};
  expect((await call(`/staff/cases/${caseId}/review`,{...review,decision:'hold'},'not-staff')).status).toBe(403);
  expect((await call(`/staff/cases/${caseId}/review`,{...review,decision:'hold'},a)).status).toBe(200);
  expect((await owner.query('SELECT status FROM app.members WHERE id=$1',[id])).rows[0].status).toBe('hold');
  expect((await owner.query('SELECT count(*)::int AS n FROM public.auth_session WHERE "userId"=$1',[id])).rows[0].n).toBe(0);
  let response=await call(`/staff/cases/${caseId}/review`,{...review,decision:'restore'},a);expect((await response.json()).approvals).toBe(1);
  response=await call(`/staff/cases/${caseId}/review`,{...review,decision:'restore'},a);expect((await response.json()).approvals).toBe(1);
  expect(emails.some(e=>e.text.includes('#restore='))).toBe(false);
  response=await call(`/staff/cases/${caseId}/review`,{...review,decision:'restore'},b);expect((await response.json()).approvals).toBe(2);
  const restoreToken=emails.find(e=>e.text.includes('#restore='))!.text.match(/#restore=([a-f0-9]{64})/)![1];
  expect((await call('/public/complete',{token:'0'.repeat(64),newPassword:'synthetic-new-password-456'})).status).toBe(400);
  const completed=await call('/public/complete',{token:restoreToken,newPassword:'synthetic-new-password-456'});expect(completed.status).toBe(200);
  expect((await call('/public/complete',{token:restoreToken,newPassword:'replayed-other-password'})).status).toBe(400);
  expect((await call('/public/case',undefined,undefined,data.recoverySession)).status).toBe(401);
  const account=(await owner.query('SELECT u.email,a.password FROM public.auth_user u JOIN public.auth_account a ON a."userId"=u.id WHERE u.id=$1',[id])).rows[0];
  expect(account.email).toBe(safeEmail);expect(await verifyPassword({hash:account.password,password:'synthetic-new-password-456'})).toBe(true);
  expect(await verifyPassword({hash:account.password,password:'synthetic-old-password-123'})).toBe(false);
  expect((await owner.query('SELECT status FROM app.members WHERE id=$1',[id])).rows[0].status).toBe('active');
 }finally{
  await Promise.allSettled(pending);
  if(caseId){await owner.query('DELETE FROM public.recovery_cases WHERE id=$1',[caseId]);await owner.query('DELETE FROM public.security_audit WHERE target=$1',[caseId]);}
  await owner.query('DELETE FROM public.staff_users WHERE subject=ANY($1)',[[a,b]]);
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[id]);await owner.query('DELETE FROM app.members WHERE id=$1',[id]);await owner.end();
 }
},30000);
