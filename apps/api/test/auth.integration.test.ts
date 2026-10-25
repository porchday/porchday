import {test,expect,vi,afterEach} from 'vitest';
afterEach(()=>vi.restoreAllMocks());
import {Pool} from 'pg';
import {createAuth} from '../src/auth';
import type {Env} from '../src/types';
const enabled=Boolean(process.env.TEST_DATABASE_URL);
test.skipIf(!enabled)('invite-bound signup verifies email, password reset revokes sessions and does not expose private keys',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(!String(url).startsWith('https://api.pwnedpasswords.com/range/'))throw Error('Unexpected test network');return new Response('00000000000000000000000000000000000:0',{headers:{'content-type':'text/plain'}});});
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const email=`auth-${crypto.randomUUID()}@example.test`;
 const id=crypto.randomUUID(); const handle='p'+id.replaceAll('-','').slice(0,15);
 const deliveries:{subject:string;text:string}[]=[];
 const env={APP_URL:'http://localhost:8787',ENVIRONMENT:'development',BETTER_AUTH_SECRET:'local-test-only-very-long-secret-not-production',EMAIL_FROM:'Porchday <accounts@porchday.com>',EMAIL:{send:async (m:unknown)=>{deliveries.push(m as {subject:string;text:string});return {messageId:'test'};}}} as unknown as Env;
 try{
  await pool.query("INSERT INTO public.pilot_invitations(token_hash,email,expires_at,consumed_user,handle,adult_attested_at,rules_accepted_at) VALUES($1,$2,now()+interval '1 hour',$3,$4,now(),now())",[crypto.randomUUID(),email,id,handle]);
  const auth=createAuth(env,pool,id);
  const call=(path:string,body:unknown)=>auth.handler(new Request(env.APP_URL+'/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json','Origin':env.APP_URL},body:JSON.stringify(body)}));
  const signup=await call('sign-up/email',{email,password:'a-long-synthetic-password-123',name:handle});
  expect(signup.status).toBe(200);
  const member=await pool.query('SELECT app.auth_member_status($1::uuid) AS status',[id]);expect(member.rows[0].status).toBe('active');
  expect(deliveries[0].subject).toBe('Verify your Porchday email');
  const blocked=await call('sign-in/email',{email,password:'a-long-synthetic-password-123'});expect(blocked.status).toBe(403);
  const verifyURL=deliveries[0].text.match(/http:\/\/localhost:8787\/api\/auth\/verify-email\?\S+/)![0];
  expect((await auth.handler(new Request(verifyURL))).status).toBeLessThan(400);
  const signed=await call('sign-in/email',{email,password:'a-long-synthetic-password-123'});expect(signed.status).toBe(200);expect(signed.headers.get('set-cookie')).toContain('HttpOnly');
  await call('request-password-reset',{email,redirectTo:env.APP_URL+'/reset-password'});
  const reset=deliveries.find(x=>x.subject==='Reset your Porchday password')!;expect(reset).toBeTruthy();
  const resetURL=new URL(reset.text.match(/http:\/\/localhost:8787\/api\/auth\/reset-password\/\S+/)![0]);
  const token=resetURL.pathname.split('/').at(-1);
  expect((await call('reset-password',{token,newPassword:'new-synthetic-password-456'})).status).toBe(200);
  expect((await pool.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[id])).rowCount).toBe(0);
  expect((await call('reset-password',{token,newPassword:'replayed-synthetic-password'})).status).toBeGreaterThanOrEqual(400);
 }finally{
  await pool.query('DELETE FROM public.auth_user WHERE id=$1',[id]);await pool.query('DELETE FROM public.pilot_invitations WHERE consumed_user=$1',[id]);await pool.query('DELETE FROM app.members WHERE id=$1',[id]);await pool.end();
 }
},30000);
