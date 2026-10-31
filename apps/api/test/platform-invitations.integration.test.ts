import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {serializeSignedCookie} from 'better-call';
import {app} from '../src/index';
import {decryptAccountEmail,enqueueAccountEmail,processAccountEmails} from '../src/email-outbox';
import {hashToken} from '../src/auth';
import type {Env} from '../src/types';
import {captureLegacyInvitations,invitationRecipientKey,recordInvitationHistory} from '../src/invitation-history';
import {cleanupAuthenticationMetadata} from '../src/metadata-cleanup';

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
async function history(cookie:string,query='') {
 const pending:Promise<unknown>[]=[];
 const response=await app.fetch(new Request(env.APP_URL+'/api/v1/platform-invitations'+query,{headers:{Cookie:cookie}}),env,{waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext);
 await Promise.all(pending);return response;
}
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
 it.each(['friend','family'])('connects an opted-in %s invitation only on verification, once, with future-only history',async kind=>{
  const a=await person(),email=randomUUID()+'@example.test',id=randomUUID();
  expect((await call('/api/v1/platform-invitations',{email,kind},a.cookie)).status).toBe(202);
  const invitation=await row(email),message=await decryptAccountEmail(env,invitation.encrypted_payload);
  expect(message.text).toContain('automatically connects');
  expect(invitation.connection_kind).toBe(kind);
  await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2',[id,invitation.token_hash]);
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$1,$2,false)',[id,email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'i_'+id.replaceAll('-','').slice(0,16)]);
  expect((await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows).toHaveLength(0);
  // Run verification with the same restricted auth role used by the server.
  const auth=new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString});
  try {await auth.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id]);} finally {await auth.end();}
  const connections=(await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows;
  expect(connections).toHaveLength(1);expect(connections[0]).toMatchObject({kind_a:kind,kind_b:kind,history_a:'future',history_b:'future'});
  const list=await (await history(a.cookie,'?v=2')).json() as any;
  expect(list.items[0]).toMatchObject({status:'joined',kind});
  expect((await call('/api/v1/platform-invitations/'+list.items[0].id+'/revoke',{},a.cookie)).status).toBe(409);
  await owner.query('DELETE FROM app.connections WHERE id=$1',[connections[0].id]);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=false WHERE id=$1',[id]);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id]);
  expect((await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows).toHaveLength(0);
 });
 it('revokes only the sender receipt, invalidates claims and queued mail, and supports old list clients',async()=>{
  const a=await person(),b=await person(),email=randomUUID()+'@example.test';
  await call('/api/v1/platform-invitations',{email,kind:'family'},a.cookie);
  const invitation=await row(email),list=await (await history(a.cookie,'?v=2')).json() as any,id=list.items[0].id;
  expect(list.items[0]).toMatchObject({status:'pending',kind:'family'});
  expect((await call('/api/v1/platform-invitations/'+id+'/revoke',{},b.cookie)).status).toBe(404);
  expect((await call('/api/v1/platform-invitations/'+id+'/revoke',{},a.cookie,{SOCIAL_INVITATIONS_PAUSED:'true'})).status).toBe(200);
  expect((await call('/api/v1/platform-invitations/'+id+'/revoke',{},a.cookie)).status).toBe(200);
  expect(((await (await history(a.cookie,'?v=2')).json()) as any).items[0].status).toBe('revoked');
  expect(((await (await history(a.cookie)).json()) as any).items[0].status).toBe('expired');
  expect((await owner.query('SELECT public.platform_invitation_deliverable($1) AS value',[invitation.token_hash])).rows[0].value).toBe(false);
  expect((await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2 RETURNING token_hash',[randomUUID(),invitation.token_hash])).rowCount).toBe(0);
 });
 it('revocation after claiming but before verification prevents the automatic connection',async()=>{
  const a=await person(),email=randomUUID()+'@example.test',id=randomUUID();
  await call('/api/v1/platform-invitations',{email,kind:'friend'},a.cookie);
  const invitation=await row(email);
  await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2',[id,invitation.token_hash]);
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$1,$2,false)',[id,email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'i_'+id.replaceAll('-','').slice(0,16)]);
  const list=await (await history(a.cookie,'?v=2')).json() as any;
  expect((await call('/api/v1/platform-invitations/'+list.items[0].id+'/revoke',{},a.cookie)).status).toBe(200);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id]);
  expect((await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows).toHaveLength(0);
 });
 it('does not reveal suppressed invitations through the requested label',async()=>{
  const a=await person(),existing=await person(),email=randomUUID()+'@example.test';
  for(const recipient of [existing.email,email])expect((await call('/api/v1/platform-invitations',{email:recipient,kind:'family'},a.cookie)).status).toBe(202);
  const list=await (await history(a.cookie,'?v=2')).json() as any;
  expect(list.items.map((i:any)=>({kind:i.kind,status:i.status}))).toEqual([{kind:'family',status:'pending'},{kind:'family',status:'pending'}]);
 });
 it('serializes concurrent verification and revocation without connecting after a successful revoke',async()=>{
  for(let attempt=0;attempt<4;attempt++){
   const a=await person(),email=randomUUID()+'@example.test',id=randomUUID();
   await call('/api/v1/platform-invitations',{email,kind:'family'},a.cookie);
   const invitation=await row(email);
   await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2',[id,invitation.token_hash]);
   await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$1,$2,false)',[id,email]);
   await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'i_'+id.replaceAll('-','').slice(0,16)]);
   const list=await (await history(a.cookie,'?v=2')).json() as any;
   const [revocation]=await Promise.all([
    call('/api/v1/platform-invitations/'+list.items[0].id+'/revoke',{},a.cookie),
    owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id])
   ]);
   expect([200,409]).toContain(revocation.status);
   expect((await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows).toHaveLength(revocation.status===200?0:1);
  }
 });
 it.each(['blocked','restricted'])('does not connect when the inviter becomes %s before verification',async state=>{
  const a=await person(),email=randomUUID()+'@example.test',id=randomUUID();
  await call('/api/v1/platform-invitations',{email,kind:'family'},a.cookie);
  const invitation=await row(email);
  await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1 WHERE token_hash=$2',[id,invitation.token_hash]);
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$1,$2,false)',[id,email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'i_'+id.replaceAll('-','').slice(0,16)]);
  if(state==='blocked')await owner.query('INSERT INTO app.blocks(actor,target) VALUES($1,$2)',[a.id,id]);
  else await owner.query("UPDATE app.members SET status='restricted' WHERE id=$1",[a.id]);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id]);
  expect((await owner.query('SELECT * FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows).toHaveLength(0);
 });
 it('a fresh credential after the cooldown clears an old revocation without changing a duplicate label',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';
  await call('/api/v1/platform-invitations',{email,kind:'family'},a.cookie);
  await call('/api/v1/platform-invitations',{email,kind:'friend'},a.cookie);
  let list=await (await history(a.cookie,'?v=2')).json() as any;
  expect(list.items[0].kind).toBe('family');
  const old=await row(email);
  await call('/api/v1/platform-invitations/'+list.items[0].id+'/revoke',{},a.cookie);
  await owner.query("UPDATE public.platform_invitation_requests SET created_at=now()-interval '8 days' WHERE sender_id=$1",[a.id]);
  await owner.query('DELETE FROM public.pilot_invitations WHERE token_hash=$1',[old.token_hash]);
  await call('/api/v1/platform-invitations',{email,kind:'friend'},a.cookie);
  list=await (await history(a.cookie,'?v=2')).json() as any;
  expect(list.items[0]).toMatchObject({kind:'friend',status:'pending'});
  expect((await row(email)).token_hash).not.toBe(old.token_hash);
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
 it('lists only the sender’s requests, including suppressed requests, without exposing eligibility or credentials',async()=>{
  const a=await person(),b=await person(),existing=await person(),email=randomUUID()+'@example.test';
  await invite(a.cookie,email);await invite(a.cookie,email);await invite(a.cookie,existing.email);await invite(b.cookie,email);
  expect((await history('')).status).toBe(401);
  const response=await history(a.cookie),body=await response.json() as any;
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(body.items).toHaveLength(2);expect(body.items.map((row:any)=>row.status)).toEqual(['pending','pending']);
  for(const item of body.items)expect(Object.keys(item).sort()).toEqual(['email','expires_at','id','kind','requested_at','status']);
  const other=await(await history(b.cookie)).json() as any;expect(other.items).toHaveLength(1);expect(other.items[0].email).toBe(email);expect(other.items[0].status).toBe('pending');
  const stored=(await owner.query('SELECT * FROM public.platform_invitation_history WHERE sender_id=$1',[a.id])).rows;
  expect(JSON.stringify(stored)).not.toContain(email);expect(JSON.stringify(stored)).not.toContain(existing.email);
  expect((await history(a.cookie,'?cursor=invalid')).status).toBe(400);
 });
 it('marks joined only after actual email verification and preserves that status after token expiry and recipient deletion',async()=>{
  const a=await person(),b=await person(),email=randomUUID()+'@example.test';await invite(a.cookie,email);await invite(b.cookie,email);
  const invitation=await row(email),claim=randomUUID();
  await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1,claimed_at=now() WHERE token_hash=$2',[claim,invitation.token_hash]);
  const status=async(cookie:string)=>(await(await history(cookie)).json() as any).items[0].status;
  expect(await status(a.cookie)).toBe('pending');
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',[claim,'Synthetic invited account',email]);
  expect(await status(a.cookie)).toBe('pending');
  await owner.query("UPDATE public.pilot_invitations SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[invitation.token_hash]);
  await cleanupAuthenticationMetadata(env);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[claim]);
  expect(await status(a.cookie)).toBe('joined');expect(await status(b.cookie)).toBe('pending');
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[claim]);expect(await status(a.cookie)).toBe('joined');
  expect((await owner.query('SELECT claimed_user FROM public.platform_invitation_history WHERE sender_id=$1',[a.id])).rows[0].claimed_user).toBeNull();
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[a.id]);expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_history WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);
 });
 it('preserves available legacy invitations and expires receipts independently of credential cleanup',async()=>{
  const a=await person(),token=await hashToken(randomUUID()),email=randomUUID()+'@example.test';
  await owner.query("INSERT INTO public.pilot_invitations(token_hash,email,sender_id,created_at,expires_at) VALUES($1,$2,$3,now()-interval '8 days',now()-interval '1 day')",[token,email,a.id]);
  const client=await owner.connect();try{await client.query('BEGIN');await captureLegacyInvitations(client,env);await client.query('COMMIT');}finally{client.release();}
  await cleanupAuthenticationMetadata(env);
  const data=await(await history(a.cookie)).json() as any;expect(data.items).toHaveLength(1);expect(data.items[0]).toMatchObject({email,status:'expired'});
  expect(await row(email)).toBeUndefined();
  await owner.query("UPDATE public.platform_invitation_history SET requested_at=now()-interval '91 days' WHERE sender_id=$1",[a.id]);
  expect((await(await history(a.cookie)).json() as any).items).toEqual([]);
  await cleanupAuthenticationMetadata(env);expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_history WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);
 });
 it('pages stable sender-owned history without allowing a cursor to select another sender',async()=>{
  const a=await person(),b=await person(),now=new Date();
  for(let i=0;i<52;i++){
   const email='fixture-'+i+'@example.test';
   await recordInvitationHistory(owner,env,{sender:a.id,email,key:await invitationRecipientKey(env.BETTER_AUTH_SECRET,email),requestedAt:now,expiresAt:new Date(+now+86400_000),tokenHash:null});
  }
  // PostgreSQL stores microseconds; cursors must not round a tied timestamp
  // through JavaScript Date and silently omit the rest of that page.
  await owner.query("UPDATE public.platform_invitation_history SET requested_at=date_trunc('milliseconds',now())+interval '123 microseconds' WHERE sender_id=$1",[a.id]);
  const first=await(await history(a.cookie)).json() as any;expect(first.items).toHaveLength(50);expect(first.next_cursor).toBeTruthy();
  const second=await(await history(a.cookie,'?cursor='+first.next_cursor)).json() as any;expect(second.items).toHaveLength(2);expect(second.next_cursor).toBeNull();
  expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(52);
  expect((await(await history(b.cookie,'?cursor='+first.next_cursor)).json() as any).items).toEqual([]);
  await owner.query('DELETE FROM public.auth_session WHERE id=$1',[a.session]);expect((await history(a.cookie)).status).toBe(401);
  for(const role of ['porchday_social','porchday_jobs'])expect((await owner.query("SELECT has_table_privilege($1,'public.platform_invitation_history','SELECT') AS allowed",[role])).rows[0].allowed).toBe(false);
 });
 async function joinedFixture(sender:Awaited<ReturnType<typeof person>>) {
  const email=randomUUID()+'@example.test',id=randomUUID(),handle='joined_'+id.replaceAll('-','').slice(0,12);
  await invite(sender.cookie,email);const invitation=await row(email);
  await owner.query('UPDATE public.pilot_invitations SET consumed_user=$1,claimed_at=now() WHERE token_hash=$2',[id,invitation.token_hash]);
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',[id,handle,email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,handle]);
  return {id,email,handle,verify:()=>owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[id])};
 }
 async function asMember(id:string,query:string,parameters:unknown[]=[]) {
  const client=await owner.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE porchday_social');await client.query("SELECT set_config('app.member_id',$1,true)",[id]);const result=await client.query(query,parameters);await client.query('COMMIT');return result.rows;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const notices=(id:string)=>owner.query("SELECT * FROM app.notifications WHERE recipient=$1 AND kind='invitation_joined'",[id]);
 it('notifies only the actual inviter after verified signup and exposes only that member’s connection handle',async()=>{
  const sender=await person(),other=await person(),joined=await joinedFixture(sender);
  await invite(other.cookie,joined.email);await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
  await joined.verify();await Promise.all([cleanupAuthenticationMetadata(env),cleanupAuthenticationMetadata(env)]);
  expect((await notices(sender.id)).rows).toHaveLength(1);expect((await notices(other.id)).rows).toHaveLength(0);
  expect(await asMember(sender.id,"SELECT n.kind,h.handle FROM app.notifications n LEFT JOIN LATERAL app.member_handles(array[n.actor]) h ON true WHERE kind='invitation_joined'")).toEqual([{kind:'invitation_joined',handle:joined.handle}]);
  expect(await asMember(other.id,'SELECT * FROM app.member_handles($1::uuid[])',[[joined.id]])).toEqual([]);
  expect(await asMember(sender.id,'SELECT * FROM app.profiles WHERE member_id=$1',[joined.id])).toEqual([]);
  const n=(await notices(sender.id)).rows[0];await asMember(sender.id,'UPDATE app.notifications SET read_at=now() WHERE id=$1',[n.id]);
  await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(1);
  await owner.query('DELETE FROM app.notifications WHERE id=$1',[n.id]);await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
 });
 it.each(['friend','family'])('skips existing %s connections permanently, including after a later unfriend',async kind=>{
  const sender=await person(),joined=await joinedFixture(sender);
  await owner.query('INSERT INTO app.connections(member_a,member_b,kind) VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),$3)',[sender.id,joined.id,kind]);
  await joined.verify();await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
  await owner.query('DELETE FROM app.connections WHERE $1 IN(member_a,member_b)',[joined.id]);
  await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
 });
 it.each(['block','mute','disabled','sender-held','invitee-held'])('suppresses %s invitation notices without replaying them later',async condition=>{
  const sender=await person(),joined=await joinedFixture(sender);await joined.verify();
  if(condition==='block')await owner.query('INSERT INTO app.blocks(actor,target) VALUES($1,$2)',[joined.id,sender.id]);
  if(condition==='mute')await owner.query('INSERT INTO app.mutes(actor,target) VALUES($1,$2)',[sender.id,joined.id]);
  if(condition==='disabled')await owner.query(`UPDATE app.members SET notification_preferences='{"in_app":false,"push":false}' WHERE id=$1`,[sender.id]);
  if(condition.endsWith('held'))await owner.query("UPDATE app.members SET status='hold' WHERE id=$1",[condition==='sender-held'?sender.id:joined.id]);
  await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
  expect((await owner.query('SELECT notification_checked_at IS NOT NULL AS checked FROM public.platform_invitation_history WHERE sender_id=$1',[sender.id])).rows[0].checked).toBe(true);
 });
 it('serializes notification processing with connection acceptance and respects in-app opt-out',async()=>{
  const sender=await person(),joined=await joinedFixture(sender);await joined.verify();
  const connection=await owner.connect();await connection.query('BEGIN');
  try{
   await connection.query('SELECT app.lock_pair($1,$2)',[sender.id,joined.id]);
   await connection.query("INSERT INTO app.connections(member_a,member_b,kind) VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'friend')",[sender.id,joined.id]);
   const runtime=new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString});
   try{
    let finished=false;const processing=runtime.query('SELECT app.process_invitation_joined_notices()').then(()=>{finished=true;});
    await new Promise(resolve=>setTimeout(resolve,30));expect(finished).toBe(false);
    await connection.query('COMMIT');await processing;
   }finally{await runtime.end();}
  }finally{await connection.query('ROLLBACK');connection.release();}
  expect((await notices(sender.id)).rows).toHaveLength(0);
  const pushOnly=await person(),another=await joinedFixture(pushOnly);
  await owner.query(`UPDATE app.members SET notification_preferences='{"in_app":false,"push":true}' WHERE id=$1`,[pushOnly.id]);
  await another.verify();await cleanupAuthenticationMetadata(env);
  expect((await notices(pushOnly.id)).rows).toHaveLength(1);
  expect(await asMember(pushOnly.id,"SELECT id FROM app.notifications WHERE kind='invitation_joined'")).toEqual([]);
  expect(await asMember(pushOnly.id,'SELECT * FROM app.member_handles($1::uuid[])',[[another.id]])).toEqual([]);
 });
 it('cancels queued notices when the pair connects and rechecks mute/availability for in-app and both push paths',async()=>{
  const sender=await person(),joined=await joinedFixture(sender);
  await owner.query(`UPDATE app.members SET notification_preferences='{"in_app":true,"push":true}' WHERE id=$1`,[sender.id]);
  await owner.query('INSERT INTO app.push_subscriptions(member_id,session_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4,$5)',[sender.id,sender.session,'https://fcm.googleapis.com/'+randomUUID(),'a'.repeat(87),'b'.repeat(22)]);
  await owner.query("INSERT INTO app.native_push_subscriptions(member_id,session_id,token,environment) VALUES($1,$2,$3,'sandbox')",[sender.id,sender.session,'a'.repeat(64)]);
  await joined.verify();await cleanupAuthenticationMetadata(env);const n=(await notices(sender.id)).rows[0];
  const web=(await owner.query('SELECT * FROM app.claim_push(100)')).rows, native=(await owner.query('SELECT * FROM app.claim_native_push(100)')).rows;
  expect(web).toHaveLength(1);expect(native).toHaveLength(1);
  expect((await owner.query('SELECT app.prepare_push($1,$2) AS value',[web[0].id,web[0].lease])).rows[0].value).not.toBeNull();
  expect((await owner.query('SELECT app.prepare_native_push($1,$2) AS value',[native[0].id,native[0].lease])).rows[0].value).not.toBeNull();
  await owner.query('INSERT INTO app.mutes(actor,target) VALUES($1,$2)',[sender.id,joined.id]);
  expect(await asMember(sender.id,'SELECT id FROM app.notifications WHERE id=$1',[n.id])).toEqual([]);
  expect((await owner.query('SELECT app.prepare_push($1,$2) AS value',[web[0].id,web[0].lease])).rows[0].value).toBeNull();
  expect((await owner.query('SELECT app.prepare_native_push($1,$2) AS value',[native[0].id,native[0].lease])).rows[0].value).toBeNull();
  await owner.query('DELETE FROM app.mutes WHERE actor=$1',[sender.id]);
  await owner.query("INSERT INTO app.connections(member_a,member_b,kind) VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'friend')",[sender.id,joined.id]);
  expect((await notices(sender.id)).rows).toHaveLength(0);
  expect((await owner.query('SELECT id FROM app.push_outbox WHERE notification_id=$1',[n.id])).rows).toHaveLength(0);
  expect((await owner.query('SELECT id FROM app.native_push_outbox WHERE notification_id=$1',[n.id])).rows).toHaveLength(0);
  await owner.query('DELETE FROM app.connections WHERE $1 IN(member_a,member_b)',[joined.id]);await cleanupAuthenticationMetadata(env);expect((await notices(sender.id)).rows).toHaveLength(0);
  for(const role of ['porchday_social','porchday_jobs'])expect((await owner.query("SELECT has_function_privilege($1,'app.process_invitation_joined_notices()','EXECUTE') AS allowed",[role])).rows[0].allowed).toBe(false);
 });
 it('rolls back invitation and quota metadata when durable mail insertion fails',async()=>{
  const a=await person(),email=randomUUID()+'@example.test';
  await owner.query("CREATE FUNCTION public.synthetic_mail_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic failure'; END$$; CREATE TRIGGER synthetic_failure BEFORE INSERT ON public.auth_email_outbox FOR EACH ROW EXECUTE FUNCTION public.synthetic_mail_failure()");
  try{expect((await invite(a.cookie,email)).status).toBe(503);expect(await row(email)).toBeUndefined();expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_history WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);expect((await owner.query('SELECT count(*)::int AS n FROM public.platform_invitation_requests WHERE sender_id=$1',[a.id])).rows[0].n).toBe(0);}
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
 it.each([null,'friend','family'])('uses the real signup and verification flow with label %s',async kind=>{
  const a=await person(),email=randomUUID()+'@example.test';await call('/api/v1/platform-invitations',{email,...(kind?{kind}:{})},a.cookie);
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
  const mail=(await owner.query("SELECT encrypted_payload FROM public.auth_email_outbox WHERE member_id=$1 AND purpose='account' ORDER BY created_at DESC LIMIT 1",[id])).rows[0];
  const verification=await decryptAccountEmail(env,mail.encrypted_payload);
  const url=verification.text.match(/http:\/\/localhost:8787\/api\/auth\/verify-email[^\s]+/)![0];
  const pending:Promise<unknown>[]=[];
  const verified=await app.fetch(new Request(url),env,{waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext);
  await Promise.all(pending);expect(verified.status).toBeLessThan(400);
  expect((await owner.query('SELECT "emailVerified" FROM public.auth_user WHERE id=$1',[id])).rows[0].emailVerified).toBe(true);
  const links=(await owner.query('SELECT kind_a,kind_b FROM app.connections WHERE $1::uuid IN(member_a,member_b)',[id])).rows;
  expect(links).toEqual(kind?[{kind_a:kind,kind_b:kind}]:[]);

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
