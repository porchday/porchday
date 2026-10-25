import {test,expect} from 'vitest';
import {Pool} from 'pg';
import {encryptAccountEmail,decryptAccountEmail,enqueueAccountEmail,processAccountEmails} from '../src/email-outbox';
import type {Env} from '../src/types';

const base=process.env.TEST_DATABASE_URL;
const secret={BETTER_AUTH_SECRET:'synthetic-email-outbox-key-for-local-tests-only'};
const message={to:'outbox@example.test',subject:'Test verification',text:'Synthetic single-use link: https://example.test/verify?token=not-a-real-token'};

test('operational outbox encryption hides links and rejects modified bytes or another environment key',async()=>{
 const encrypted=await encryptAccountEmail(secret,message);
 expect(encrypted).not.toContain(message.to);expect(encrypted).not.toContain('not-a-real-token');
 expect(await encryptAccountEmail(secret,message)).not.toBe(encrypted);
 expect(await decryptAccountEmail(secret,encrypted)).toEqual(message);
 const parts=encrypted.split('.'),bytes=Buffer.from(parts[2],'base64url');bytes[0]^=1;parts[2]=bytes.toString('base64url');
 await expect(decryptAccountEmail(secret,parts.join('.'))).rejects.toThrow();
 await expect(decryptAccountEmail({BETTER_AUTH_SECRET:'another-environment-key'},encrypted)).rejects.toThrow();
});

test.skipIf(!base)('auth email commits with its transaction, retries after provider failure, and disappears with deleted or held accounts',async()=>{
 const owner=new Pool({connectionString:base}),id=crypto.randomUUID(),email=id+'@example.test';
 await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='porchday_email_test') THEN CREATE ROLE porchday_email_test LOGIN PASSWORD 'local-email-test' INHERIT; END IF; END $$");
 await owner.query('GRANT porchday_auth TO porchday_email_test');
 const runtime=new URL(base!);runtime.username='porchday_email_test';runtime.password='local-email-test';
 const pool=new Pool({connectionString:runtime.href});
 let fail=true;const delivered:unknown[]=[];
 const env={...secret,HYPERDRIVE_AUTH:{connectionString:runtime.href},ENVIRONMENT:'development',EMAIL:{send:async(value:unknown)=>{if(fail)throw new Error('synthetic provider outage');delivered.push(value);}}} as unknown as Env;
 const db=await pool.connect();
 const count=async()=>(await owner.query('SELECT count(*)::int AS count FROM public.auth_email_outbox WHERE member_id=$1',[id])).rows[0].count;
 try{
  await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,'mailtest',email]);
  await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,'mail_'+id.replaceAll('-','').slice(0,15)]);
  await db.query('BEGIN');
  await enqueueAccountEmail(env,db,id,email,message.subject,message.text);
  expect(await count()).toBe(0);expect(delivered.length).toBe(0);
  await db.query('ROLLBACK');expect(await count()).toBe(0);
  await db.query('BEGIN');
  await enqueueAccountEmail(env,db,id,email,message.subject,message.text);
  await db.query('COMMIT');expect(await count()).toBe(1);
  const pending=(await owner.query('SELECT encrypted_payload FROM public.auth_email_outbox WHERE member_id=$1',[id])).rows[0];
  expect(pending.encrypted_payload).not.toContain(message.text);
  expect((await processAccountEmails(env)).retried).toBe(1);expect(delivered.length).toBe(0);
  expect((await owner.query('SELECT delivered_at,attempts FROM public.auth_email_outbox WHERE member_id=$1',[id])).rows[0]).toMatchObject({delivered_at:null,attempts:1});
  await owner.query('UPDATE public.auth_email_outbox SET next_attempt_at=now() WHERE member_id=$1',[id]);
  fail=false;expect((await processAccountEmails(env)).sent).toBe(1);
  expect(delivered[0]).toMatchObject({to:email,subject:message.subject,text:message.text});
  expect((await processAccountEmails(env)).sent).toBe(0);
  await enqueueAccountEmail(env,db,id,email,message.subject,message.text);
  await owner.query("UPDATE app.members SET status='hold' WHERE id=$1",[id]);
  expect((await processAccountEmails(env)).sent).toBe(0);expect(await count()).toBe(0);
  await owner.query("UPDATE app.members SET status='active' WHERE id=$1",[id]);
  await enqueueAccountEmail(env,db,id,email,message.subject,message.text);
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[id]);expect(await count()).toBe(0);
 }finally{
  await db.query('ROLLBACK');db.release();await pool.end();
  await owner.query('DELETE FROM public.auth_user WHERE id=$1',[id]);
  await owner.query('DELETE FROM app.members WHERE id=$1',[id]);await owner.end();
 }
});
