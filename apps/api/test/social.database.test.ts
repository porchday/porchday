import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
// An isolated disposable database; never run destructive fixtures against a deployed DB.
const url = process.env.SOCIAL_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let admin: Sql;
const actor = (who: string | null, fn: (db: TransactionSql) => Promise<unknown>) => admin.begin(async (db) => {
    await db `set local role porchday_social`;
    if (who !== null)
        await db `select set_config('app.member_id',${who},true)`;
    return fn(db);
});
async function member() { const id = randomUUID(); await admin `insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`; await admin `insert into app.profiles(member_id,handle) values(${id},${'u_' + id.replaceAll('-', '').slice(0, 20)})`; return id; }
async function device(m: string) { const id = randomUUID(); await admin `insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${id},${m},${'public'.repeat(30)},${randomUUID().replaceAll('-', '') + 'abcdefff'},'{}')`; return id; }
async function connect(a: string, b: string, kind = 'friend') { const [r] = await admin `insert into app.connections(member_a,member_b,kind) values(${[a, b].sort()[0]},${[a, b].sort()[1]},${kind}) returning id`; return r.id; }
async function post(a: string, recipient: string, expiry: string | null = null, group: string | null = null) { const id = randomUUID(); const d = await device(recipient); await admin `insert into app.posts(id,author_id,group_id,audience,envelope,epoch,expires_at) values(${id},${a},${group},${group ? 'group' : 'connections'},'{}',1,${expiry})`; await admin `insert into app.post_recipients(post_id,device_id,member_id) values(${id},${d},${recipient})`; return id; }
async function comment(a: string, p: string, parent: string | null = null, expiry: string | null = null) { const id = randomUUID(); await admin `insert into app.comments(id,post_id,parent_id,author_id,envelope,expires_at) values(${id},${p},${parent},${a},'{}',${expiry})`; return id; }
suite('PostgreSQL invariants under actual non-owner runtime role', () => {
    beforeAll(async () => { if (!url || !new URL(url).pathname.includes('test'))
        throw Error('Test database name must contain test'); admin = postgres(url, { max: 8, prepare: false, onnotice: () => { } }); await admin `drop schema if exists app cascade`; for (const name of ['001_social.sql', '002_social_functions_roles.sql', '003_device_trust.sql', '005_social_hardening.sql', '006_integrations.sql', '008_revocation_deletion.sql', '009_runtime_locks.sql', '010_social_integrity.sql', '011_lock_order.sql', '012_integration_clients.sql', '013_audience_members.sql','016_group_signatures.sql'])
        await admin.unsafe(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); }, 30000);
    afterAll(async () => { if (admin)
        await admin.end(); });
    it('denies absent and malformed identity; committed/rolled-back identity cannot leak through a reused connection', async () => {
        const a = await member();
        await device(a);
        const none = await actor(null, db => db `select * from app.profiles`);
        expect(none).toHaveLength(0);
        const invalid = await actor('not-a-uuid', db => db `select * from app.profiles`);
        expect(invalid).toHaveLength(0);
        const yes = await actor(a, db => db `select * from app.profiles`);
        expect(yes).toHaveLength(1);
        await expect(actor(a, async (db) => { await db `select * from app.profiles`; throw Error('rollback'); })).rejects.toThrow('rollback');
        expect(await actor(null, db => db `select * from app.profiles`)).toHaveLength(0);
        const [role] = await admin `select rolsuper,rolbypassrls from pg_roles where rolname='porchday_social'`;
        expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    });
    it('serializes both endpoints at the 300-person cap, including family requests', async () => {
        const center = await member();
        const peers = await Promise.all(Array.from({ length: 301 }, () => member()));
        for (const peer of peers.slice(0, 299))
            await connect(center, peer);
        const requests = await Promise.all(peers.slice(299).map(async (sender) => { const id = randomUUID(); await admin `insert into app.connection_requests(id,sender,recipient,kind) values(${id},${sender},${center},'family')`; return id; }));
        const results = await Promise.allSettled(requests.map(r => actor(center, db => db `select app.accept_connection(${r})`)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        const [count] = await admin `select count(*)::int n from app.connections where ${center} in(member_a,member_b)`;
        expect(count.n).toBe(300);
        await expect(actor(center, db => db `insert into app.connections(member_a,member_b,kind) values(${[center, peers[300]].sort()[0]},${[center, peers[300]].sort()[1]},'friend')`)).rejects.toMatchObject({ code: '42501' });
        const other = await member();
        const request = randomUUID();
        await admin `insert into app.connection_requests(id,sender,recipient,kind) values(${request},${center},${other},'friend')`;
        await expect(actor(other, db => db `select app.accept_connection(${request})`)).rejects.toThrow('CONNECTION_LIMIT');
    }, 30000);
    it('requires mutual relabel agreement without changing counts and frees slots on removal', async () => {
        const a = await member(), b = await member();
        const id = await connect(a, b);
        await actor(a, db => db `select app.change_connection(${id},'family',false)`);
        let [r] = await admin `select * from app.connections where id=${id}`;
        expect(r.kind).toBe('friend');
        expect(r.proposed_by).toBe(a);
        await actor(a, db => db `select app.change_connection(${id},'family',false)`);
        [r] = await admin `select * from app.connections where id=${id}`;
        expect(r.kind).toBe('friend');
        await actor(b, db => db `select app.change_connection(${id},'family',false)`);
        [r] = await admin `select * from app.connections where id=${id}`;
        expect(r.kind).toBe('family');
        await actor(a, db => db `select app.change_connection(${id},null,true)`);
        expect(await admin `select * from app.connections where id=${id}`).toHaveLength(0);
    });
    it('authorizes non-friend comments through their parent; block and relationship removal revoke all descendants and media', async () => {
        const a = await member(), b = await member(), c = await member();
        const ab = await connect(a, b);
        await connect(a, c);
        const p = await post(a, b);
        const dc = await device(c);
        await admin `insert into app.post_recipients(post_id,device_id,member_id) values(${p},${dc},${c})`;
        const commentId = await comment(c, p);
        const media = randomUUID();
        await admin `insert into app.media_assets(id,owner_id,post_id,object_key,envelope,byte_size,state) values(${media},${a},${p},${media},'{}',10,'attached')`;
        expect(await actor(b, db => db `select * from app.comments where id=${commentId}`)).toHaveLength(1);
        await actor(b, db => db `select app.set_block(${c},true)`);
        expect(await actor(b, db => db `select * from app.comments where id=${commentId}`)).toHaveLength(0);
        await actor(b, db => db `select app.change_connection(${ab},null,true)`);
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(0);
        expect(await actor(b, db => db `select * from app.media_assets where id=${media}`)).toHaveLength(0);
        const stranger = await member();
        expect(await actor(stranger, db => db `select * from app.posts where id=${p}`)).toHaveLength(0);
    });
    it('denies expired content before cleanup and cascades bytes through a durable independent outbox', async () => {
        const a = await member(), b = await member();
        await connect(a, b);
        const expiry = new Date(Date.now() + 500).toISOString();
        const p = await post(a, b, expiry);
        const c = await comment(b, p, null, expiry);
        const m = randomUUID();
        await admin `insert into app.media_assets(id,owner_id,post_id,object_key,envelope,byte_size,state) values(${m},${a},${p},${m},'{}',10,'attached')`;
        await admin `insert into app.post_reactions(post_id,member_id,reaction_tag,envelope) values(${p},${a},'abcdefghijklmnop','{}')`;
        await new Promise(resolve => setTimeout(resolve, 550));
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(0);
        expect(await actor(b, db => db `select * from app.comments where id=${c}`)).toHaveLength(0);
        expect(await actor(b, db => db `select * from app.media_assets where id=${m}`)).toHaveLength(0);
        expect(await actor(b, db => db `select * from app.post_reactions where post_id=${p}`)).toHaveLength(0);
        await admin `select app.expire_batch(200)`;
        expect(await admin `select * from app.comments where id=${c}`).toHaveLength(0);
        expect(await admin `select * from app.deletion_outbox where object_key=${m}`).toHaveLength(1);
        expect(await admin `select * from app.deletion_ledger where object_id=${p}`).toHaveLength(1);
    });
    it('inherits absolute ancestor deadlines, denies extending, and deletes only the affected branch', async () => {
        const a = await member(), b = await member();
        await connect(a, b);
        const p = await post(a, b);
        const deadline = new Date(Date.now() + 500).toISOString();
        const parent = await comment(a, p, null, deadline);
        const child = await comment(b, p, parent, deadline);
        const sibling = await comment(a, p);
        await expect(comment(b, p, parent, null)).rejects.toThrow('INHERITED_DEADLINE');
        await expect(admin `update app.comments set expires_at=now()+interval '1 day' where id=${parent}`).rejects.toThrow('EXPIRY_CANNOT_EXTEND');
        await new Promise(resolve => setTimeout(resolve, 550));
        expect(await actor(a, db => db `select * from app.comments where id=${child}`)).toHaveLength(0);
        expect(await actor(a, db => db `select * from app.comments where id=${sibling}`)).toHaveLength(1);
        await admin `select app.expire_batch(200)`;
        expect(await admin `select * from app.comments where id=${child}`).toHaveLength(0);
        expect(await admin `select * from app.posts where id=${p}`).toHaveLength(1);
    });
    it('allows distinct encrypted reaction tags and deduplicates concurrent retries', async () => {
        const a = await member(), b = await member();
        await connect(a, b);
        const p = await post(a, b);
        const add = (tag: string) => actor(b, db => db `insert into app.post_reactions(post_id,member_id,reaction_tag,envelope) values(${p},${b},${tag},'{}') on conflict do nothing`);
        await Promise.all([add('abcdefghijklmnop'), add('abcdefghijklmnop'), add('qrstuvwxyzabcdef')]);
        expect(await actor(b, db => db `select * from app.post_reactions where post_id=${p}`)).toHaveLength(2);
        await actor(b, db => db `delete from app.post_reactions where post_id=${p} and reaction_tag='abcdefghijklmnop'`);
        expect(await actor(b, db => db `select * from app.post_reactions where post_id=${p}`)).toHaveLength(1);
    });
    it('group access ends on departure and ownership cannot be abandoned', async () => {
        const a = await member(), b = await member();
        const g = randomUUID();
        const authorDevice = await device(a);
        const groupEnvelope = { context: { authorId: a, authorDeviceId: authorDevice } };
        await actor(a, db => db `select app.create_group(${g},${db.json(groupEnvelope)})`);
        await admin `insert into app.group_memberships(group_id,member_id,role) values(${g},${b},'member')`;
        const p = await post(b, b, null, g);
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(1);
        await expect(actor(a, db => db `select app.change_group_member(${g},${a},'remove')`)).rejects.toThrow('TRANSFER_REQUIRED');
        await actor(b, db => db `select app.change_group_member(${g},${b},'remove')`);
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(0);
    });
    it('does not revive historical grants after reconnecting and rejects tombstoned content IDs', async () => {
        const a = await member(), b = await member();
        const relationship = await connect(a, b);
        const p = await post(a, b);
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(1);
        await actor(a, db => db `select app.change_connection(${relationship},null,true)`);
        await connect(a, b);
        expect(await actor(b, db => db `select * from app.posts where id=${p}`)).toHaveLength(0);
        await actor(a, db => db `delete from app.posts where id=${p}`);
        await expect(admin `insert into app.posts(id,author_id,audience,envelope,epoch) values(${p},${a},'only_me','{}',1)`).rejects.toThrow('CONTENT_DELETED');
    });
    it('cannot leave an accessible orphan comment during concurrent parent deletion', async () => {
        const a = await member(), b = await member();
        await connect(a, b);
        const p = await post(a, b);
        const cid = randomUUID();
        const results = await Promise.allSettled([actor(a, db => db `delete from app.posts where id=${p}`), actor(b, async (db) => { await db `select * from app.lock_post(${p})`; await db `insert into app.comments(id,post_id,author_id,envelope) values(${cid},${p},${b},'{}')`; })]);
        expect(results.some(r => r.status === 'fulfilled')).toBe(true);
        expect(await admin `select * from app.comments where post_id=${p}`).toHaveLength(0);
    });
    it('keeps restricted own export but denies takeover holds and privileged staff access', async () => {
        const a = await member();
        await device(a);
        await admin `update app.members set status='restricted' where id=${a}`;
        const rows: any = await actor(a, db => db `select app.export_owned() as archive`);
        expect(rows[0].archive.profile.member_id).toBe(a);
        await admin `select app.set_security_hold(${a})`;
        const held: any = await actor(a, db => db `select app.export_owned() as archive`);
        expect(held[0].archive).toBeNull();
        await expect(actor(a, db => db `select app.set_security_hold(${a})`)).rejects.toMatchObject({ code: '42501' });
    });
});
