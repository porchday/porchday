import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generateDeviceKeys, unlockPrivateKey, encryptObject, decryptObject } from '@porchday/crypto';
const url = process.env.MODERATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let sql: Sql;
const staff = (fn: (db: TransactionSql) => Promise<unknown>) => sql.begin(async (db) => { await db `set local role porchday_auth`; return fn(db); });
const member = (id: string, fn: (db: TransactionSql) => Promise<unknown>) => sql.begin(async (db) => { await db `set local role porchday_social`; await db `select set_config('app.member_id',${id},true)`; return fn(db); });
async function seed(subject?: string) { const id = randomUUID(), device = randomUUID(); const email = id + '@example.test'; await sql `insert into public.auth_user(id,name,email,"emailVerified") values(${id},'private member',${email},true)`; await sql `insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`; await sql `insert into app.profiles(member_id,handle) values(${id},${'m_' + id.replaceAll('-', '').slice(0, 20)})`; const keys = await generateDeviceKeys(id, device); await sql `insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${id},${keys.publicKey},${keys.fingerprint},'{}')`; if (subject)
    await sql `insert into public.staff_users(subject,email,roles) values(${subject},${email},array['moderation'])`; return { id, device, keys, key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret) }; }
suite('Moderation disclosure, role isolation and independent appeals', () => {
    beforeAll(async () => { if (!url || !new URL(url).pathname.includes('test'))
        throw Error('Disposable test DB only'); sql = postgres(url, { prepare: false, max: 4, onnotice: () => { } }); await sql `drop schema if exists app cascade`; await sql `drop schema public cascade`; await sql `create schema public`; for (const name of ['000_auth.sql', '001_social.sql', '002_social_functions_roles.sql', '003_device_trust.sql', '004_auth_privileges.sql', '005_social_hardening.sql', '006_integrations.sql', '007_account_recovery.sql', '008_revocation_deletion.sql', '009_runtime_locks.sql', '010_social_integrity.sql', '011_lock_order.sql', '012_integration_clients.sql', '013_audience_members.sql', '014_moderation.sql', '015_report_verification.sql'])
        await sql.unsafe(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); }, 30000);
    afterAll(async () => { if (sql)
        await sql.end(); });
    it('publishes only verified staff-owned device keys and decrypts only voluntarily disclosed evidence', async () => {
        const moderator = await seed('moderator-one'), reporter = await seed(), other = await seed();
        await expect(staff(db => db `select app.register_moderator_key('moderator-one',${other.device},${other.id},${other.keys.publicKey},${other.keys.fingerprint})`)).rejects.toThrow('STAFF_KEY_MISMATCH');
        await staff(db => db `select app.register_moderator_key('moderator-one',${moderator.device},${moderator.id},${moderator.keys.publicKey},${moderator.keys.fingerprint})`);
        const directory: any = await member(reporter.id, db => db `select * from app.moderator_devices()`);
        expect(directory).toHaveLength(1);
        expect(directory[0].id).toBe(moderator.device);
        const reportId = randomUUID();
        const context = { id: reportId, kind: 'report' as const, authorId: reporter.id, authorDeviceId: reporter.device, audience: 'moderators' as const, parentId: null, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1 };
        const envelope = await encryptObject({ context, payload: { selectedText: 'Only this text was disclosed' }, signingKey: reporter.key, recipients: [{ memberId: reporter.id, deviceId: reporter.device, publicKey: reporter.keys.publicKey }, { memberId: moderator.id, deviceId: moderator.device, publicKey: moderator.keys.publicKey }] });
        await member(reporter.id, db => db `insert into app.reports(id,reporter,target_member,reason,evidence_envelope,evidence_disclosed) values(${reportId},${reporter.id},${other.id},'harassment',${db.json(envelope)},true)`);
        const disclosed: any = await staff(db => db `select app.staff_report('moderator-one',${reportId}) as report`);
        const author: any = await staff(db => db `select app.report_author_key('moderator-one',${reportId}) as key`);
        expect(await decryptObject({ envelope: disclosed[0].report.evidence_envelope, expectedContext: context, privateKey: moderator.key, authorPublicKey: author[0].key.public_key })).toEqual({ selectedText: 'Only this text was disclosed' });
        await expect(staff(db => db `select * from app.posts`)).rejects.toMatchObject({ code: '42501' });
        await expect(member(other.id, db => db `select app.staff_report('moderator-one',${reportId})`)).rejects.toMatchObject({ code: '42501' });
        expect(await sql `select * from app.moderation_access_audit where report_id=${reportId}`).toHaveLength(2);
        await sql `delete from app.members where id=${reporter.id}`;
        const retained: any = await staff(db => db `select app.report_author_key('moderator-one',${reportId}) as key`);
        expect(retained[0].key.public_key).toBe(reporter.keys.publicKey);
        await sql `update public.staff_users set active=false where subject='moderator-one'`;
        expect(await member(other.id, db => db `select * from app.moderator_devices()`)).toHaveLength(0);
        await expect(staff(db => db `select app.staff_report('moderator-one',${reportId})`)).rejects.toThrow('STAFF_FORBIDDEN');
    }, 30000);
    it('restricts social actions but preserves export and requires a different moderator to decide an appeal', async () => {
        const moderator = await seed('moderator-two'), independent = await seed('moderator-three'), person = await seed(), reporter = await seed();
        const reportId = randomUUID();
        await member(reporter.id, db => db `insert into app.reports(id,reporter,target_member,reason) values(${reportId},${reporter.id},${person.id},'agent')`);
        const result: any = await staff(db => db `select app.moderate_report('moderator-two',${reportId},'restrict','automated_activity') as id`);
        const [status] = await sql `select status from app.members where id=${person.id}`;
        expect(status.status).toBe('restricted');
        const permissions: any = await member(person.id, db => db `select app.may_write() as write,app.export_owned() as archive`);
        expect(permissions[0].write).toBe(false);
        expect(permissions[0].archive.profile.member_id).toBe(person.id);
        const appeal: any = await member(person.id, db => db `select app.submit_appeal(${result[0].id},null) as id`);
        await expect(staff(db => db `select app.moderate_report('moderator-two',${appeal[0].id},'restore','appeal_upheld')`)).rejects.toThrow('INDEPENDENT_REVIEW_REQUIRED');
        await staff(db => db `select app.moderate_report('moderator-three',${appeal[0].id},'restore','appeal_upheld')`);
        const [restored] = await sql `select status from app.members where id=${person.id}`;
        expect(restored.status).toBe('active');
        await sql `select app.set_security_hold(${person.id})`;
        await expect(staff(db => db `select app.moderate_report('moderator-three',${reportId},'restore','appeal_upheld')`)).rejects.toThrow('SECURITY_CASE_REQUIRED');
    }, 30000);
});
