import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {serializeSignedCookie} from 'better-call';
import {app} from '../src/index';
import {decryptAccountEmail,enqueueAccountEmail,processAccountEmails} from '../src/email-outbox';
import {hashToken} from '../src/auth';
import type {Env} from '../src/types';

const base=process.env.TEST_DATABASE_URL,suite=base?describe:describe.skip;
const suffix=randomUUID().replaceAll('-',''),database='porchday_invitations_'+suffix,role='porchday_invite_auth_'+suffix;
let admin:Pool,owner:Pool,env:Env,mailFails=true;
const delivered:{to:string;subject:string;text:string}[]=[];
async function person(){
 const id=randomUUID(),email=id+'@example.test',handle='i_'+id.replaceAll('-','').slice(0,16),session=randomUUID(),token=randomUUID();
 await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,handle,email]);
 await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,handle]);
 await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()+interval\'7 days\',$2,$3)',[session,token,id]);
 const cookie=(await serializeSignedCookie('better-auth.session_token',token,env.BETTER_AUTH_SECRET)).split(';')[0];
 return {id,email,handle,session,cookie};
}
async function call(path:string,body:unknown,cookie='',overrides:Partial<Env>={},origin=env.APP_URL){
 const pending:Promise<unknown>[]=[];
 const response=await app.fetch(new Request(env.APP_URL+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','CF-Connecting-IP':randomUUID()},body:JSON.stringify(body)}),{...env,...overrides},{waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext);
 await Promise.all(pending);
 return response;
}
const invite=(cookie:string,email:string,overrides:Partial<Env>={})=>call('/api/v1/platform-invitations',{email},cookie,overrides);
async function row(email:string){return (await owner.query(`SELECT i.*,o.encrypted_payload,o.attempts,o.delivered_at FROM public.pilot_invitations i LEFT JOIN public.auth_email_outbox o ON o.invitation_token_hash=i.token_hash WHERE i.email=$1`,[email])).rows[0];}
suite('member platform invitations through real auth sessions and restricted SQL role',()=>{
 beforeAll(async()=>{
  const url=new URL(base!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Disposable loopback database required');
  url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});
  await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;owner=new Pool({connectionString:url.href,max:2});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await owner.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-invitation-test' IN ROLE porchday_auth`);
  url.username=role;url.password='synthetic-invitation-test';
  env={APP_URL:'http://localhost:8787',ENVIRONMENT:'development',SIGNUP_ENABLED:'true',BETTER_AUTH_SECRET:'synthetic-invitation-key-longer-than-thirty-two-characters',EMAIL_FROM:'accounts@example.test',HYPERDRIVE_AUTH:{connectionString:url.href},EMAIL:{send:async(message:unknown)=>{if(mailFails)throw Error('Synthetic provider unavailable');delivered.push(message as typeof delivered[number]);}}} as unknown as Env;
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(!String(url).startsWith('https://api.pwnedpasswords.com/range/'))throw Error('Unexpected test network');return new Response('00000000000000000000000000000000000:0');});
 },30000);
 afterAll(async()=>{
  vi.restoreAllMocks();if(owner)await owner.end();
  if(admin)try{
   let drained=false;for(let i=0;i<200;i++){if((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n===0){drained=true;break;}await new Promise(r=>setTimeout(r,25));}
   if(!drained)throw Error('DISPOSABLE_DATABASE_CONNECTIONS_DID_NOT_DRAIN');
   await admin.query('DROP DATABASE IF EXISTS '+database);await admin.query('DROP ROLE IF EXISTS '+role);
  }finally{await admin.end();}
 });
 it('requires Origin, verified active session, signup gate, privacy guard and incident permission before creating mail',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';
  expect((await invite('',email)).status).toBe(401);
  expect((await call('/api/v1/platform-invitations',{email},a.cookie,{},'https://hostile.example')).status).toBe(403);
  expect((await invite(a.cookie,email,{SIGNUP_ENABLED:'false'})).status).toBe(403);
  expect((await invite(a.cookie,email,{SOCIAL_INVITATIONS_PAUSED:'true'})).status).toBe(503);
  expect((await invite(a.cookie,email,{ENVIRONMENT:'production'})).status).toBe(503);
  await owner.query("UPDATE app.members SET status='restricted' WHERE id=$1",[a.id]);
  expect((await invite(a.cookie,email)).status).toBe(403);
  await owner.query("UPDATE app.members SET status='active' WHERE id=$1",[a.id]);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=false WHERE id=$1',[a.id]);
  expect((await invite(a.cookie,email)).status).toBe(401);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[a.id]);
  expect((await invite(a.cookie,'bad\r\nBcc: bad@example.test')).status).toBe(400);
  expect((await call('/api/v1/platform-invitations',{email,message:'not supported'},a.cookie)).status).toBe(400);
  expect(await row(email)).toBeUndefined();
  expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_requests WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);
 });
 it('atomically encrypts the exact invitation mail, hides recipient existence and retries delivery without issuing a new token',async()=>{
  const a=await person(),existing=await person(),email=randomUUID()+'@example.test';
  const sent=await invite(a.cookie,'  '+email.toUpperCase()+'  '),duplicate=await invite(a.cookie,email),member=await invite(a.cookie,existing.email);
  expect([sent.status,duplicate.status,member.status]).toEqual([202,202,202]);
  expect(await duplicate.json()).toEqual(await sent.clone().json());expect(await member.json()).toEqual(await sent.json());
  const stored=await row(email),message=await decryptAccountEmail(env,stored.encrypted_payload);
  expect(message.to).toBe(email);expect(message.text).toContain('@'+a.handle);expect(message.text).toContain('does not automatically connect');
  const link=new URL(message.text.match(/http:\/\/localhost:8787\/join#invite=[A-Za-z0-9_-]+/)![0]);
  const token=new URLSearchParams(link.hash.slice(1)).get('invite')!;
  expect(token).toHaveLength(43);expect(await hashToken(token)).toBe(stored.token_hash);expect(stored.encrypted_payload).not.toContain(token);
  expect(+new Date(stored.expires_at)-+new Date(stored.created_at)).toBe(7*24*60*60_000);
  expect(message.text).toContain(new Date(stored.expires_at).toISOString());
  expect(stored.attempts).toBe(1);expect(stored.delivered_at).toBeNull();expect(await row(existing.email)).toBeUndefined();
  // An outage lasting longer than the usual auth-mail lifetime, or eight
  // failures, must not strand a still-valid invitation behind its cooldown.
  await owner.query("UPDATE public.auth_email_outbox SET created_at=now()-interval '31 minutes',attempts=7,next_attempt_at=now() WHERE invitation_token_hash=$1",[stored.token_hash]);
  await processAccountEmails(env);
  const retry=(await owner.query('SELECT attempts,failed_at,expires_at,extract(epoch FROM(next_attempt_at-now()))::int AS delay FROM public.auth_email_outbox WHERE invitation_token_hash=$1',[stored.token_hash])).rows[0];
  expect(retry.attempts).toBe(8);expect(retry.failed_at).toBeNull();expect(retry.expires_at).toEqual(stored.expires_at);expect(retry.delay).toBeGreaterThan(900);expect(retry.delay).toBeLessThanOrEqual(21600);
  await owner.query('UPDATE public.auth_email_outbox SET next_attempt_at=now() WHERE invitation_token_hash=$1',[stored.token_hash]);
  mailFails=false;
  const before=delivered.length;await processAccountEmails({...env,SIGNUP_ENABLED:'false'});expect(delivered.length).toBe(before);
  await processAccountEmails({...env,SOCIAL_INVITATIONS_PAUSED:'true'});expect(delivered.length).toBe(before);
  await processAccountEmails(env);expect(delivered.slice(before)).toMatchObject([message]);
  expect((await row(email)).token_hash).toBe(stored.token_hash);await processAccountEmails(env);expect(delivered.length).toBe(before+1);
  mailFails=true;
 });
 it('serializes ten-per-rolling-day sender quota and cross-sender recipient dedup under concurrency',async()=>{
  const a=await person(),b=await person(),c=await person();
  const requests=await Promise.all(Array.from({length:12},()=>invite(a.cookie,randomUUID()+'@example.test')));
  expect(requests.filter(r=>r.status===202)).toHaveLength(10);expect(requests.filter(r=>r.status===429)).toHaveLength(2);
  expect(Number(requests.find(r=>r.status===429)!.headers.get('Retry-After'))).toBeGreaterThan(0);
  const email=randomUUID()+'@example.test';
  expect((await Promise.all([invite(b.cookie,email),invite(c.cookie,email.toUpperCase())])).map(r=>r.status)).toEqual([202,202]);
  expect((await owner.query('SELECT count(*)::int AS n FROM public.pilot_invitations WHERE email=$1',[email])).rows[0].n).toBe(1);
  expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_requests WHERE sender_id IN($1,$2)',[b.id,c.id])).rows[0].n).toBe(2);
  await owner.query("UPDATE public.platform_invitation_requests SET created_at=now()-interval '25 hours' WHERE sender_id=$1",[a.id]);
  expect((await invite(a.cookie,randomUUID()+'@example.test')).status).toBe(202);
 });
 it('rolls back invitation and quota metadata when durable mail insertion fails',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';
  await owner.query("CREATE FUNCTION public.synthetic_mail_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic failure'; END$$; CREATE TRIGGER synthetic_failure BEFORE INSERT ON public.auth_email_outbox FOR EACH ROW EXECUTE FUNCTION public.synthetic_mail_failure()");
  try{expect((await invite(a.cookie,email)).status).toBe(503);expect(await row(email)).toBeUndefined();expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_requests WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);}
  finally{await owner.query('DROP TRIGGER synthetic_failure ON public.auth_email_outbox; DROP FUNCTION public.synthetic_mail_failure()');}
 });
 it('prioritizes account/security mail over an older invitation backlog',async()=>{
  const a=await person();
  await enqueueAccountEmail(env,owner,a.id,a.email,'Synthetic account security notice','A normal account notice.');
  await owner.query("UPDATE public.auth_email_outbox SET next_attempt_at=now(),created_at=now()-interval '1 minute' WHERE purpose='platform_invitation' AND delivered_at IS NULL");
  mailFails=false;const before=delivered.length;
  await processAccountEmails(env);
  expect(delivered.slice(before).some(m=>m.to===a.email&&m.subject==='Synthetic account security notice')).toBe(true);
  expect(delivered.length-before).toBe(10);
  mailFails=true;
 });
 it('uses the real email-bound one-use signup gate and never auto-connects the new account',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';await invite(a.cookie,email);
  const stored=await row(email),message=await decryptAccountEmail(env,stored.encrypted_payload);
  const token=message.text.match(/#invite=([A-Za-z0-9_-]+)/)![1];
  const body={email,handle:'new_'+randomUUID().replaceAll('-','').slice(0,15),password:'synthetic-invitation-password-12345',adult:true,acceptedRules:true,inviteCode:token};
  expect((await call('/api/auth/sign-up/email',{...body,email:randomUUID()+'@example.test'})).status).toBe(403);
  expect((await call('/api/auth/sign-up/email',{...body,adult:false})).status).toBe(400);
  const signup=await call('/api/auth/sign-up/email',body);expect(signup.status).toBe(200);
  const id=(await signup.json() as {user:{id:string}}).user.id;
  expect((await call('/api/auth/sign-up/email',body)).status).toBe(403);
  expect((await owner.query('SELECT "emailVerified" FROM public.auth_user WHERE id=$1',[id])).rows[0].emailVerified).toBe(false);
  expect((await owner.query('SELECT count(*)::int AS n FROM app.connections WHERE member_a=$1 OR member_b=$1',[id])).rows[0].n).toBe(0);
  expect((await owner.query('SELECT count(*)::int AS n FROM app.connection_requests WHERE sender=$1 OR recipient=$1',[id])).rows[0].n).toBe(0);
 });
 it('suppresses mail and signup for inactive inviter, expiry or deletion; restore purge removes queued capabilities; runtime roles stay isolated',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';await invite(a.cookie,email);const stored=await row(email);
  await owner.query("UPDATE app.members SET status='restricted' WHERE id=$1",[a.id]);
  const runtime=new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString});
  try{
   const claim=await runtime.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2 AND consumed_user IS NULL RETURNING consumed_user',[randomUUID(),stored.token_hash]);expect(claim.rowCount).toBe(0);
  }finally{await runtime.end();}
  await processAccountEmails(env);expect((await row(email)).encrypted_payload).toBeNull();
  const b=await person(),deletedEmail=randomUUID()+'@example.test';await invite(b.cookie,deletedEmail);
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[b.id]);expect(await row(deletedEmail)).toBeUndefined();
  expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_requests WHERE sender_id IS NULL AND issued')).rows[0].n).toBeGreaterThan(0);
  const replacementSender=await person();expect((await invite(replacementSender.cookie,deletedEmail)).status).toBe(202);expect(await row(deletedEmail)).toBeUndefined();
  const c=await person(),expiredEmail=randomUUID()+'@example.test';await invite(c.cookie,expiredEmail);await owner.query("UPDATE public.pilot_invitations SET expires_at=now()-interval '1 second' WHERE email=$1",[expiredEmail]);
  await processAccountEmails(env);expect((await row(expiredEmail)).encrypted_payload).toBeNull();
  const purgedEmail=randomUUID()+'@example.test';await invite(c.cookie,purgedEmail);
  await owner.query('DELETE FROM public.pilot_invitations');expect(await row(purgedEmail)).toBeUndefined();
  expect((await owner.query("SELECT count(*)::int AS n FROM public.auth_email_outbox WHERE purpose='platform_invitation'")).rows[0].n).toBe(0);
  for(const role of ['porchday_social','porchday_jobs']){
   expect((await owner.query("SELECT has_table_privilege($1,'public.platform_invitation_requests','SELECT') AS allowed",[role])).rows[0].allowed).toBe(false);
   expect((await owner.query("SELECT has_function_privilege($1,'app.platform_inviter(text)','EXECUTE') AS allowed",[role])).rows[0].allowed).toBe(false);
  }
 });
});
