import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generateDeviceKeys, unlockPrivateKey, encryptObject, decryptObject, signStatement, authorizeDevice, createReactionSecret, reactionTag, type UnlockedPrivateKey, type ContentContext } from '@porchday/crypto';
import { createSocialRoutes } from '../src/social';
import { createIntegrationConsentRoutes, createIntegrationTokenRoutes } from '../src/social-integrations';
import type { Env, Variables } from '../src/types';
const url = process.env.SOCIAL_HTTP_DATABASE_URL;
const suite = url ? describe : describe.skip;
let sql: Sql;
let app: Hono<{
    Bindings: Env;
    Variables: Variables;
}>;
let env: Env;
interface Person {
    id: string;
    deviceId: string;
    key: UnlockedPrivateKey;
    publicKey: string;
}
const objects = new Map<string, ArrayBuffer>();
async function request(member: string, path: string, method = 'GET', value?: unknown) { const init: RequestInit = { method, headers: { 'x-test-member': member, ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }; const response = await app.request('https://porchday.test' + path, init, env); const data = await response.json(); if (response.status >= 500)
    throw Error(JSON.stringify({ path, status: response.status, data })); return { status: response.status, data }; }
async function person() { const id = randomUUID(), deviceId = randomUUID(); await sql `insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`; await sql `insert into app.profiles(member_id,handle) values(${id},${'t_' + id.replaceAll('-', '').slice(0, 20)})`; const keys = await generateDeviceKeys(id, deviceId); const recovery = await generateDeviceKeys(id, 'recovery', keys.recoverySecret); const { status } = await request(id, '/devices', 'POST', { id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, authorization: { type: 'initial' }, recovery_public_key: recovery.publicKey, backup: { v: 1, devices: [{ id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, encrypted_private_key: keys.encryptedPrivateKey }], recovery: { public_key: recovery.publicKey, fingerprint: recovery.fingerprint, encrypted_private_key: recovery.encryptedPrivateKey } } }); expect(status).toBe(201); return { id, deviceId, key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret), publicKey: keys.publicKey }; }
async function connection(a: Person, b: Person, kind: 'friend' | 'family' = 'friend') { const [r] = await sql `select handle from app.profiles where member_id=${b.id}`; const create = await request(a.id, '/connections/requests', 'POST', { handle: r.handle, kind }); expect(create.status).toBe(201); expect((await request(b.id, `/connections/requests/${create.data.id}/accept`, 'POST')).status).toBe(200); }
async function seal(a: Person, payload: unknown, override: Partial<ContentContext> = {}, postId?: string) { const audience = override.audience ?? 'connections'; const snap = await request(a.id, `/audiences?audience=${audience}${override.groupId ? '&group_id=' + override.groupId : ''}${postId ? '&post_id=' + postId : ''}`); expect(snap.status).toBe(200); const context: ContentContext = { id: randomUUID(), kind: 'post', authorId: a.id, authorDeviceId: a.deviceId, audience, parentId: null, groupId: null, epoch: snap.data.epoch, createdAt: new Date().toISOString(), expiresAt: null, revision: 1, ...override, epoch: snap.data.epoch }; return encryptObject({ context, payload, signingKey: a.key, recipients: snap.data.devices.map((d: any) => ({ memberId: d.member_id, deviceId: d.id, publicKey: d.public_key })) }); }
suite('Social HTTP routes with real OpenPGP envelopes and runtime RLS', () => {
    beforeAll(async () => { if (!url || !new URL(url).pathname.includes('test'))
        throw Error('Only disposable test database'); sql = postgres(url, { prepare: false, max: 4, onnotice: () => { } }); await sql `drop schema if exists app cascade`; for (const name of ['001_social.sql', '002_social_functions_roles.sql', '003_device_trust.sql', '005_social_hardening.sql', '006_integrations.sql', '008_revocation_deletion.sql', '009_runtime_locks.sql', '010_social_integrity.sql', '011_lock_order.sql', '012_integration_clients.sql', '013_audience_members.sql', '016_group_signatures.sql', '017_private_media_storage.sql', '018_paged_exports.sql', '019_export_validation.sql', '021_social_history.sql', '022_suspended_data_rights.sql','023_paged_integrations.sql', '026_bounded_export_windows.sql'])
        await sql.unsafe(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); await sql.unsafe(await readFile(new URL('../migrations/034_feed_candidates.sql', import.meta.url), 'utf8')); await sql.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_http_runtime') THEN CREATE ROLE porchday_http_runtime LOGIN PASSWORD 'porchday-test-social' IN ROLE porchday_social; END IF; END $$"); const runtime = new URL(url); runtime.username = 'porchday_http_runtime'; runtime.password = 'porchday-test-social'; env = { HYPERDRIVE_SOCIAL: { connectionString: runtime.href }, MEDIA: { put: async (k: string, b: ArrayBuffer) => { objects.set(k, b); }, get: async (k: string) => objects.has(k) ? { body: objects.get(k) } : null, delete: async (k: string) => { objects.delete(k); } } } as unknown as Env; app = new Hono(); app.route('/integration', createIntegrationTokenRoutes()); app.use('*', async (c, next) => { c.set('memberId', c.req.header('x-test-member')!); c.set('authTime', Date.now()); await next(); }); app.route('/', createSocialRoutes()); app.route('/', createIntegrationConsentRoutes()); }, 30000);
    afterAll(async () => { if (sql)
        await sql.end(); });
    it('paginates tied feed dates without widening historic, family, private, group, expired, muted or blocked audiences', async () => {
        const viewer = await person(), relative = await person(), friend = await person(), newcomer = await person();
        const visible: {id: string; at: string}[] = [];
        async function publish(author: Person, override: Partial<ContentContext> = {}, included = false) {
            const envelope = await seal(author, {text: 'Encrypted feed fixture'}, override);
            expect((await request(author.id, '/posts', 'POST', {envelope})).status).toBe(201);
            const record = {id: envelope.context.id, at: envelope.context.createdAt};
            if (included) visible.push(record);
            return record;
        }
        const old = await publish(newcomer); // No historical grant when later connected.
        await connection(viewer, relative, 'family');
        await connection(viewer, friend);
        await connection(viewer, newcomer);
        const own = await publish(viewer, {audience: 'only_me'}, true);
        const family = await publish(relative, {audience: 'family'}, true);
        const friendPost = await publish(friend, {}, true);
        const newPost = await publish(newcomer, {}, true);
        await publish(friend, {audience: 'family'});
        await publish(friend, {audience: 'only_me'});
        const expired = await publish(friend, {createdAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()});
        await sql`update app.posts set expires_at=now()-interval '1 second' where id=${expired.id}`;
        const groupEnvelope = await seal(viewer, {name: 'Separate group'}, {kind: 'group', audience: 'only_me'});
        expect((await request(viewer.id, '/groups', 'POST', {envelope: groupEnvelope})).status).toBe(201);
        await publish(viewer, {audience: 'group', groupId: groupEnvelope.context.id});
        const tie = new Date(Date.now() - 1000).toISOString();
        for (let n = 0; n < 32; n++) await publish(relative, {createdAt: tie}, true);
        const first = await request(viewer.id, '/feed');
        expect(first.data.items).toHaveLength(30);
        expect(first.data.next_cursor).toBeTruthy();
        const second = await request(viewer.id, '/feed?cursor=' + encodeURIComponent(first.data.next_cursor));
        expect(second.data.next_cursor).toBeNull();
        const ids = [...first.data.items, ...second.data.items].map((p: any) => p.id);
        expect(ids).toEqual(visible.toSorted((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).map(p => p.id));
        expect(new Set(ids).size).toBe(36);
        expect(ids).not.toContain(old.id);
        expect(first.data.items.every((p: any) => typeof p.author_handle === 'string')).toBe(true);
        expect((await request(viewer.id, '/mutes/' + relative.id, 'PUT')).status).toBe(200);
        expect(new Set((await request(viewer.id, '/feed')).data.items.map((p: any) => p.id))).toEqual(new Set([own.id, friendPost.id, newPost.id]));
        expect((await request(viewer.id, '/blocks/' + friend.id, 'PUT')).status).toBe(200);
        expect(new Set((await request(viewer.id, '/feed')).data.items.map((p: any) => p.id))).toEqual(new Set([own.id, newPost.id]));
        expect((await request(viewer.id, '/posts/' + friendPost.id)).status).toBe(404);
        await request(viewer.id, '/mutes/' + relative.id, 'DELETE');
        const [edge] = await sql`select id from app.connections where ${viewer.id} in(member_a,member_b) and ${relative.id} in(member_a,member_b)`;
        expect((await request(viewer.id, '/connections/' + edge.id + '/kind', 'PUT', {kind: 'friend'})).status).toBe(200);
        expect((await request(relative.id, '/connections/' + edge.id + '/kind', 'PUT', {kind: 'friend'})).status).toBe(200);
        const afterDemotion = await request(viewer.id, '/feed');
        expect(afterDemotion.data.items.map((p: any) => p.id)).not.toContain(family.id);
        expect(afterDemotion.data.items.some((p: any) => p.author_id === relative.id)).toBe(true);
    }, 60_000);
    it('shares encrypted posts, photos, threaded comments and distinct reactions; requires signed edits and rejects stale audiences', async () => {
        const a = await person(), b = await person(), stranger = await person();
        await connection(a, b);
        const postId = randomUUID(), mediaId = randomUUID(), secret = createReactionSecret();
        const mediaEnvelope = await seal(a, { mime: 'image/jpeg', bytes: 'c2FtcGxlIG9ubHk=', alt: 'Synthetic test fixture' }, { id: mediaId, kind: 'media', parentId: postId });
        const mediaBytes = new TextEncoder().encode(JSON.stringify(mediaEnvelope));
        const created = await request(a.id, '/media', 'POST', { id: mediaId, envelope: mediaEnvelope, byte_size: mediaBytes.length });
        expect(created.status).toBe(201);
        const upload = await app.request('https://porchday.test/media/' + mediaId + '/bytes', { method: 'PUT', headers: { 'x-test-member': a.id, 'content-type': 'application/octet-stream' }, body: mediaBytes }, env);
        expect(upload.status).toBe(200);
        const [metadata] = await sql`select envelope,envelope_sha256 from app.media_assets where id=${mediaId}`;
        expect(metadata.envelope.ciphertext).toBeUndefined();
        expect(metadata.envelope_sha256).toMatch(/^[0-9a-f]{64}$/);
        const envelope = await seal(a, { text: 'A private test post', reactionSecret: secret, media: [{ id: mediaId }] }, { id: postId });
        expect((await request(a.id, '/posts', 'POST', { envelope, media_ids: [mediaId] })).status).toBe(201);
        const shared = await request(b.id, '/posts/' + postId);
        expect(shared.status).toBe(200);
        expect(await decryptObject({ envelope: shared.data.post.envelope, expectedContext: envelope.context, privateKey: b.key, authorPublicKey: a.publicKey })).toMatchObject({ text: 'A private test post' });
        expect((await request(stranger.id, '/posts/' + postId)).status).toBe(404);
        const forbiddenMedia = await app.request('https://porchday.test/media/' + mediaId + '/bytes', { headers: { 'x-test-member': stranger.id } }, env);
        expect(forbiddenMedia.status).toBe(404);
        const photo = await app.request('https://porchday.test/media/' + mediaId + '/bytes', { headers: { 'x-test-member': b.id } }, env);
        expect(photo.status).toBe(200);
        expect(await decryptObject({ envelope: await photo.json() as any, expectedContext: mediaEnvelope.context, privateKey: b.key, authorPublicKey: a.publicKey })).toMatchObject({ alt: 'Synthetic test fixture' });
        const comment = await seal(b, { text: 'Reply', reactionSecret: createReactionSecret() }, { kind: 'comment', parentId: postId }, postId);
        expect((await request(b.id, `/posts/${postId}/comments`, 'POST', { envelope: comment, parent_expires_at: null })).status).toBe(201);
        for (const emoji of ['like', 'love']) {
            const tag = await reactionTag({ secret, targetId: postId, memberId: b.id, emoji });
            const reaction = await seal(b, { emoji }, { id: tag, kind: 'reaction', parentId: postId }, postId);
            expect((await request(b.id, `/posts/${postId}/reactions/${tag}`, 'PUT', { envelope: reaction })).status).toBe(200);
            expect((await request(b.id, `/posts/${postId}/reactions/${tag}`, 'PUT', { envelope: reaction })).status).toBe(200);
        }
        expect((await request(b.id, '/posts/' + postId)).data.reactions).toHaveLength(2);
        const stale = await seal(a, { text: 'stale' });
        await connection(a, stranger);
        expect((await request(a.id, '/posts', 'POST', { envelope: stale })).data.error.code).toBe('AUDIENCE_CHANGED');
        const edited = await seal(a, { text: 'Edited private post', reactionSecret: secret }, { ...envelope.context, revision: 2 }, postId);
        const lifecycle = await signStatement({ purpose: 'porchday-lifecycle', id: postId, revision: 2, expiresAt: null }, a.key);
        expect((await request(a.id, '/posts/' + postId, 'PUT', { envelope: edited, lifecycle })).status).toBe(200);
        expect((await request(b.id, '/posts/' + postId)).data.post.envelope.context.revision).toBe(2);
        expect((await request(a.id, '/posts/' + postId, 'DELETE')).status).toBe(200);
        expect((await request(b.id, '/posts/' + postId)).status).toBe(404);
        expect(await sql `select * from app.comments where id=${comment.context.id}`).toHaveLength(0);
        expect(await sql `select * from app.deletion_outbox where object_key like ${'%/' + mediaId}`).toHaveLength(1);
    }, 60000);
    it('requires review when parent deadline changes and never accepts a longer inherited timer', async () => {
        const a = await person(), b = await person();
        await connection(a, b);
        const deadline = new Date(Date.now() + 60000).toISOString();
        const envelope = await seal(a, { text: 'Timed' }, { expiresAt: deadline });
        expect((await request(a.id, '/posts', 'POST', { envelope })).status).toBe(201);
        const earlier = new Date(Date.now() + 30000).toISOString();
        const edited = await seal(a, { text: 'Timed' }, { ...envelope.context, revision: 2, expiresAt: earlier }, envelope.context.id);
        const lifecycle = await signStatement({ purpose: 'porchday-lifecycle', id: envelope.context.id, revision: 2, expiresAt: earlier }, a.key);
        expect((await request(a.id, '/posts/' + envelope.context.id, 'PUT', { envelope: edited, lifecycle })).status).toBe(200);
        const comment = await seal(b, { text: 'Pending' }, { kind: 'comment', parentId: envelope.context.id, expiresAt: deadline }, envelope.context.id);
        const result = await request(b.id, `/posts/${envelope.context.id}/comments`, 'POST', { envelope: comment, parent_expires_at: deadline });
        expect(result.status).toBe(409);
        expect(result.data.error.details.expires_at).toBe(earlier);
        const tooLong = await request(b.id, `/posts/${envelope.context.id}/comments`, 'POST', { envelope: comment, parent_expires_at: earlier });
        expect(tooLong.status).toBe(400);
    }, 30000);
    it('requires a signed one-use device challenge and excludes revoked keys from future ciphertext', async () => {
        const a = await person();
        const nextId = randomUUID();
        const next = await generateDeviceKeys(a.id, nextId);
        const challenge = await request(a.id, '/devices/challenge', 'POST', { id: nextId, public_key: next.publicKey, fingerprint: next.fingerprint });
        expect(challenge.status).toBe(200);
        const signed = await authorizeDevice({ v: 1, purpose: 'porchday-device-authorization', memberId: a.id, authorizingDeviceId: a.deviceId, deviceId: nextId, fingerprint: next.fingerprint, challenge: challenge.data.challenge, expiresAt: challenge.data.expires_at }, a.key);
        const backup=(await request(a.id,'/keys/backup')).data.envelope;
        backup.devices.push({id:nextId,public_key:next.publicKey,fingerprint:next.fingerprint,encrypted_private_key:next.encryptedPrivateKey});
        expect((await request(a.id,'/devices','POST',{id:nextId,public_key:next.publicKey,fingerprint:next.fingerprint,authorization:{type:'trusted',signed}})).data.error.code).toBe('RECOVERY_SETUP_REQUIRED');
        const bad = await request(a.id, '/devices', 'POST', { id: nextId, public_key: next.publicKey, fingerprint: next.fingerprint, backup, authorization: { type: 'trusted', signed: { ...signed, statement: { ...signed.statement, challenge: 'B'.repeat(64) } } } });
        expect(bad.status).toBe(403);
        expect((await request(a.id, '/devices', 'POST', { id: nextId, public_key: next.publicKey, fingerprint: next.fingerprint, backup, authorization: { type: 'trusted', signed } })).status).toBe(201);
        expect((await request(a.id,'/keys/backup')).data.envelope).toEqual(backup);
        const [stored] = await sql `select consumed_at from app.device_challenges where device_id=${nextId}`;
        expect(stored.consumed_at).not.toBeNull();
        expect((await request(a.id, '/devices/' + a.deviceId, 'DELETE')).status).toBe(200);
        const audience = await request(a.id, '/audiences?audience=only_me');
        expect(audience.data.devices.map((d: any) => d.id)).toEqual([nextId]);
        const newId = randomUUID(), malicious = await generateDeviceKeys(a.id, newId);
        const c2 = await request(a.id, '/devices/challenge', 'POST', { id: newId, public_key: malicious.publicKey, fingerprint: malicious.fingerprint });
        const revokedProof = await authorizeDevice({ v: 1, purpose: 'porchday-device-authorization', memberId: a.id, authorizingDeviceId: a.deviceId, deviceId: newId, fingerprint: malicious.fingerprint, challenge: c2.data.challenge, expiresAt: c2.data.expires_at }, a.key);
        backup.devices.push({id:newId,public_key:malicious.publicKey,fingerprint:malicious.fingerprint,encrypted_private_key:malicious.encryptedPrivateKey});
        expect((await request(a.id, '/devices', 'POST', { id: newId, public_key: malicious.publicKey, fingerprint: malicious.fingerprint, backup, authorization: { type: 'trusted', signed: revokedProof } })).status).toBe(403);
    }, 30000);
    it('explicitly reshares only owned posts into a fresh audience without copying threads or extending expiry',async()=>{
      const a=await person(),b=await person();const deadline=new Date(Date.now()+3600000).toISOString();
      const source=await seal(a,{text:'Original private moment'},{audience:'only_me',expiresAt:deadline});expect((await request(a.id,'/posts','POST',{envelope:source})).status).toBe(201);
      await connection(a,b);expect((await request(b.id,'/posts/'+source.context.id)).status).toBe(404);
      const copy=await seal(a,{text:'Reviewed copy',reactionSecret:createReactionSecret(),provenance:{postId:source.context.id}},{expiresAt:deadline});
      expect((await request(a.id,`/posts/${source.context.id}/reshare`,'POST',{envelope:copy,source_expires_at:null})).data.error.code).toBe('PARENT_DEADLINE_CHANGED');
      const forever=await seal(a,{text:'Too long'},{expiresAt:null});expect((await request(a.id,`/posts/${source.context.id}/reshare`,'POST',{envelope:forever,source_expires_at:deadline})).data.error.code).toBe('EXPIRY_CANNOT_EXTEND');
      expect((await request(a.id,`/posts/${source.context.id}/reshare`,'POST',{envelope:copy,source_expires_at:deadline})).status).toBe(201);
      const shared=await request(b.id,'/posts/'+copy.context.id);expect(shared.status).toBe(200);expect(shared.data.comments).toEqual([]);expect(shared.data.reactions).toEqual([]);
      const strangerCopy=await seal(b,{text:'Cannot forward another member'},{expiresAt:deadline});expect((await request(b.id,`/posts/${copy.context.id}/reshare`,'POST',{envelope:strangerCopy,source_expires_at:deadline})).status).toBe(403);
      expect((await request(a.id,'/posts/'+source.context.id,'DELETE')).status).toBe(200);expect((await request(b.id,'/posts/'+copy.context.id)).status).toBe(200);
    },30000);
    it('preserves suspended member own-data export and deletion while denying social access and takeover exports',async()=>{
      const a=await person();const envelope=await seal(a,{text:'My portable memory'},{audience:'only_me'});expect((await request(a.id,'/posts','POST',{envelope})).status).toBe(201);await sql`update app.members set status='suspended' where id=${a.id}`;
      const job=await request(a.id,'/exports','POST');expect(job.status).toBe(201);const page=await request(a.id,`/exports/${job.data.id}?section=posts`);expect(page.status).toBe(200);expect(page.data.posts).toHaveLength(1);expect((await request(a.id,'/devices/'+a.deviceId)).status).toBe(200);expect((await request(a.id,'/keys/backup')).status).toBe(200);expect((await request(a.id,'/feed')).data.items).toHaveLength(0);
      await sql`select app.set_security_hold(${a.id})`;expect((await request(a.id,`/exports/${job.data.id}?section=posts`)).status).toBe(403);await sql`update app.members set status='suspended' where id=${a.id}`;await sql.begin(async db=>{await db`set local role porchday_social`;await db`select set_config('app.member_id',${a.id},true)`;await db`select app.delete_member()`;});expect(await sql`select * from app.members where id=${a.id}`).toHaveLength(0);expect(await sql`select * from app.identity_deletion_outbox where member_id=${a.id}`).toHaveLength(1);
    },30000);
    it('uses PKCE and rotating scoped read-own tokens, immediately revokes grants, and offers no social write access', async () => {
        const a = await person();
        const client = await request(a.id, '/integrations/clients', 'POST', { name: 'Test migration', purpose: 'Read own encrypted records', redirect_uri: 'https://migration.example/callback' });
        expect(client.status).toBe(201);
        const verifier = 'A'.repeat(43);
        const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
        const auth = await request(a.id, '/integrations/authorize', 'POST', { client_id: client.data.id, redirect_uri: 'https://migration.example/callback', scope: ['profile:read'], code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state-long-enough', consent: true });
        expect(auth.status).toBe(200);
        const code = new URL(auth.data.redirect_uri).searchParams.get('code');
        const token = await request('', '/integration/token', 'POST', { grant_type: 'authorization_code', client_id: client.data.id, redirect_uri: 'https://migration.example/callback', code, code_verifier: verifier });
        expect(token.status).toBe(200);
        const bearer = { authorization: 'Bearer ' + token.data.access_token };
        expect((await app.request('https://porchday.test/integration/own/profile', { headers: bearer }, env)).status).toBe(200);
        expect((await app.request('https://porchday.test/integration/own/content', { headers: bearer }, env)).status).toBe(401);
        expect((await request('', '/integration/token', 'POST', { grant_type: 'authorization_code', client_id: client.data.id, redirect_uri: 'https://migration.example/callback', code, code_verifier: verifier })).status).toBe(401);
        expect((await app.request('https://porchday.test/integration/own/posts', { method: 'POST', headers: bearer }, env)).status).toBe(404);
        expect((await request(a.id, '/integrations/' + auth.data.grant_id, 'DELETE')).status).toBe(200);
        expect((await app.request('https://porchday.test/integration/own/profile', { headers: bearer }, env)).status).toBe(401);
    }, 30000);
    it('rejects changed encrypted upload bytes and attaches profile photos with revocable connection access', async () => {
        const a=await person(),b=await person(),stranger=await person();await connection(a,b);
        const mediaId=randomUUID();const envelope=await seal(a,{mime:'image/jpeg',bytes:'c2FtcGxl',alt:'Profile fixture'},{id:mediaId,kind:'media',parentId:a.id});
        const bytes=new TextEncoder().encode(JSON.stringify(envelope));
        expect((await request(a.id,'/media','POST',{id:mediaId,envelope,byte_size:bytes.length})).status).toBe(201);
        // Change signed routing while preserving the byte count; this must fail before R2 writes.
        const tampered=JSON.stringify({...envelope,context:{...envelope.context,authorId:stranger.id}});
        const bad=await app.request('https://porchday.test/media/'+mediaId+'/bytes',{method:'PUT',headers:{'x-test-member':a.id,'content-type':'application/octet-stream'},body:tampered},env);
        expect(bad.status).toBe(409);expect(objects.size===0||!objects.has('media/'+a.id+'/'+mediaId)).toBe(true);
        const upload=await app.request('https://porchday.test/media/'+mediaId+'/bytes',{method:'PUT',headers:{'x-test-member':a.id,'content-type':'application/octet-stream'},body:bytes},env);expect(upload.status).toBe(200);
        const profile=await seal(a,{displayName:'Photo owner',avatar:{id:mediaId}},{id:a.id,kind:'profile'});
        expect((await request(a.id,'/profiles/me','PUT',{envelope:profile})).status).toBe(200);
        expect((await request(stranger.id,'/media/'+mediaId+'/attachment','PUT',{kind:'profile',target_id:a.id,slot:'avatar'})).status).toBe(403);
        expect((await request(a.id,'/media/'+mediaId+'/attachment','PUT',{kind:'profile',target_id:a.id,slot:'avatar'})).status).toBe(200);
        const photo=()=>app.request('https://porchday.test/media/'+mediaId+'/bytes',{headers:{'x-test-member':b.id}},env);
        expect((await photo()).status).toBe(200);
        // An attached profile photo is not treated as an abandoned post upload.
        await sql`update app.media_assets set created_at=now()-interval '2 days' where id=${mediaId}`;await sql`select app.expire_batch(200)`;
        expect((await photo()).status).toBe(200);
        await request(b.id,'/blocks/'+a.id,'PUT');expect((await photo()).status).toBe(404);
        await sql`delete from app.media_assets where id=${mediaId}`;expect(await sql`select id from app.deletion_outbox where object_key=${'media/'+a.id+'/'+mediaId}`).toHaveLength(1);
    },30000);
    it('pages only authored export data and validates revisions, deadlines and cancelled jobs', async () => {
        const a=await person(),other=await person();const entries=[];
        for(let i=0;i<28;i++) {const envelope=await seal(a,{text:'Export '+i},{audience:'only_me'});entries.push(envelope);expect((await request(a.id,'/posts','POST',{envelope})).status).toBe(201);}
        const foreign=await seal(other,{text:'Never export another member'},{audience:'only_me'});await request(other.id,'/posts','POST',{envelope:foreign});
        const job=(await request(a.id,'/exports','POST')).data;
        const manifest=await request(a.id,'/exports/'+job.id);expect(manifest.data.sections).toContain('posts');expect(manifest.data.posts).toBeUndefined();
        const first=await request(a.id,'/exports/'+job.id+'?section=posts');expect(first.data.posts).toHaveLength(25);expect(first.data.next_cursor).toBeTruthy();
        const second=await request(a.id,'/exports/'+job.id+'?section=posts&cursor='+encodeURIComponent(first.data.next_cursor));expect(second.data.posts).toHaveLength(3);expect(second.data.next_cursor).toBeNull();
        const exported=[...first.data.posts,...second.data.posts];expect(new Set(exported.map(x=>x.id)).size).toBe(28);expect(exported.some(x=>x.id===foreign.context.id)).toBe(false);
        const refs=exported.map(x=>({kind:'post',id:x.export_id,revision:x.envelope.context.revision,expires_at:x.expires_at}));
        expect((await request(a.id,'/exports/'+job.id+'/validate','POST',{items:refs})).status).toBe(200);
        const forbidden=await app.request('https://porchday.test/exports/'+job.id+'?section=posts',{headers:{'x-test-member':other.id}},env);expect(forbidden.status).toBe(409);
        await sql`update app.posts set envelope=jsonb_set(envelope,'{context,revision}','2') where id=${exported[0].id}`;
        expect((await request(a.id,'/exports/'+job.id+'/validate','POST',{items:refs})).status).toBe(409);
        await request(a.id,'/exports/'+job.id,'DELETE');
        expect((await request(a.id,'/exports/'+job.id+'?section=posts')).status).toBe(409);
    },30000);

    it('bounds serialized export bytes as well as record count', async () => {
        const a=await person();const base=await seal(a,{text:'Synthetic large-ciphertext routing fixture'},{audience:'only_me'});
        for(let i=0;i<3;i++){
            const id=randomUUID(),envelope={...base,context:{...base.context,id},ciphertext:'-----BEGIN PGP MESSAGE-----\\n'+'A'.repeat(2_200_000)};
            await sql.unsafe('insert into app.posts(id,author_id,audience,envelope,epoch) values($1,$2,$3,$4,$5)',[id,a.id,'only_me',JSON.stringify(envelope),base.context.epoch]);
        }
        const job=(await request(a.id,'/exports','POST')).data;
        let cursor='',count=0,pages=0;
        do {
            const page=await request(a.id,'/exports/'+job.id+'?section=posts'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
            expect(page.status).toBe(200);expect(page.data.posts).toHaveLength(1);
            expect(new TextEncoder().encode(JSON.stringify(page.data)).byteLength).toBeLessThan(4_194_304);
            count+=page.data.posts.length;pages++;cursor=page.data.next_cursor;
        }while(cursor);
        expect(count).toBe(3);expect(pages).toBe(3);
    },30000);

});
