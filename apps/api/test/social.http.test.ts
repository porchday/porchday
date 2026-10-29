import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { generateDeviceKeys, unlockPrivateKey, encryptObject, decryptObject, signStatement, authorizeDevice, createReactionSecret, reactionTag, type UnlockedPrivateKey, type ContentContext } from '@porchday/crypto';
import { createSocialRoutes } from '../src/social';
import { createIntegrationConsentRoutes, createIntegrationTokenRoutes } from '../src/social-integrations';
import type { Env, Variables } from '../src/types';
import * as database from '../src/db';
import { tracingMiddleware } from '../src/tracing';
import { requestTimingMiddleware } from '../src/request-timing';
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
const writing=new Set<string>();
const objectMetadata=(key:string)=>{const bytes=objects.get(key);return bytes?{key,size:bytes.byteLength,etag:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}:null;};
const memoryBucket={
 async put(key:string,body:BodyInit){if(objects.has(key)||writing.has(key))return null;writing.add(key);try{objects.set(key,await new Response(body).arrayBuffer());return objectMetadata(key);}finally{writing.delete(key);}},
 async get(key:string){const bytes=objects.get(key);return bytes?{...objectMetadata(key),body:new Response(bytes).body,arrayBuffer:async()=>bytes,json:()=>new Response(bytes).json()}:null;},
 async head(key:string){return objectMetadata(key);},
 async delete(key:string){objects.delete(key);},
};
async function request(member: string, path: string, method = 'GET', value?: unknown) { const init: RequestInit = { method, headers: { 'x-test-member': member, ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }; const response = await app.request('https://porchday.test' + path, init, env); const data = await response.json(); if (response.status >= 500)
    throw Error(JSON.stringify({ path, status: response.status, data })); return { status: response.status, data }; }
async function person() { const id = randomUUID(), deviceId = randomUUID(); await sql `insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`; await sql `insert into app.profiles(member_id,handle) values(${id},${'t_' + id.replaceAll('-', '').slice(0, 20)})`; const keys = await generateDeviceKeys(id, deviceId); const recovery = await generateDeviceKeys(id, 'recovery', keys.recoverySecret); const { status } = await request(id, '/devices', 'POST', { id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, authorization: { type: 'initial' }, recovery_public_key: recovery.publicKey, backup: { v: 1, devices: [{ id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, encrypted_private_key: keys.encryptedPrivateKey }], recovery: { public_key: recovery.publicKey, fingerprint: recovery.fingerprint, encrypted_private_key: recovery.encryptedPrivateKey } } }); expect(status).toBe(201); return { id, deviceId, key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret), publicKey: keys.publicKey }; }
async function connection(a: Person, b: Person, kind: 'friend' | 'family' = 'friend') { const [r] = await sql `select handle from app.profiles where member_id=${b.id}`; const create = await request(a.id, '/connections/requests', 'POST', { handle: r.handle, kind }); expect(create.status).toBe(201); expect((await request(b.id, `/connections/requests/${create.data.id}/accept`, 'POST', {kind})).status).toBe(200); }
async function seal(a: Person, payload: unknown, override: Partial<ContentContext> = {}, postId?: string) { const audience = override.audience ?? 'connections'; const snap = await request(a.id, `/audiences?audience=${audience}${override.groupId ? '&group_id=' + override.groupId : ''}${postId ? '&post_id=' + postId : ''}`); expect(snap.status).toBe(200); const context: ContentContext = { id: randomUUID(), kind: 'post', authorId: a.id, authorDeviceId: a.deviceId, audience, parentId: null, groupId: null, epoch: snap.data.epoch, createdAt: new Date().toISOString(), expiresAt: null, revision: 1, ...override, epoch: snap.data.epoch }; return encryptObject({ context, payload, signingKey: a.key, recipients: snap.data.devices.map((d: any) => ({ memberId: d.member_id, deviceId: d.id, publicKey: d.public_key })) }); }
suite('Social HTTP routes with real OpenPGP envelopes and runtime RLS', () => {
    beforeAll(async () => { if (!url || !new URL(url).pathname.includes('test'))
        throw Error('Only disposable test database'); sql = postgres(url, { prepare: false, max: 4, onnotice: () => { } }); await sql `drop schema if exists app cascade`;
        // This suite intentionally installs only social migrations. Supply the
        // staff-table prerequisite of migration 050; full auth/staff migrations
        // and restricted-role bootstrap are covered by builder-chat.integration.
        await sql.unsafe("CREATE TABLE IF NOT EXISTS public.staff_users(subject text PRIMARY KEY,email text NOT NULL,active boolean NOT NULL DEFAULT true,roles text[] NOT NULL DEFAULT '{}',CONSTRAINT staff_roles_allowed CHECK(roles <@ ARRAY['recovery','moderation']::text[]))");
        for (const name of ['001_social.sql', '002_social_functions_roles.sql', '003_device_trust.sql', '005_social_hardening.sql', '006_integrations.sql', '008_revocation_deletion.sql', '009_runtime_locks.sql', '010_social_integrity.sql', '011_lock_order.sql', '012_integration_clients.sql', '013_audience_members.sql', '016_group_signatures.sql', '017_private_media_storage.sql', '018_paged_exports.sql', '019_export_validation.sql', '021_social_history.sql', '022_suspended_data_rights.sql','023_paged_integrations.sql', '026_bounded_export_windows.sql'])
        await sql.unsafe(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); for (const name of ['034_feed_candidates.sql', '035_surface_media_removal.sql', '036_media_raw_digest.sql', '037_media_upload_cleanup.sql', '038_integration_expiry_limits.sql', '041_deletion_pass_health.sql', '043_friends_audience.sql']) await sql.unsafe(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')); await sql.unsafe(`CREATE TABLE app.test_history_journal(decision jsonb NOT NULL); CREATE FUNCTION app.append_safety_decision(decision jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ INSERT INTO app.test_history_journal VALUES(decision) $$;`); for (const name of ['045_emoji_library.sql','046_connection_history.sql','047_independent_connection_labels.sql','052_group_invitation_roster.sql','050_builder_chat.sql','057_builder_bootstrap_hint.sql']) await sql.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')); await sql.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_http_runtime') THEN CREATE ROLE porchday_http_runtime LOGIN PASSWORD 'porchday-test-social' IN ROLE porchday_social; END IF; END $$"); const runtime = new URL(url); runtime.username = 'porchday_http_runtime'; runtime.password = 'porchday-test-social'; env = { HYPERDRIVE_SOCIAL: { connectionString: runtime.href }, MEDIA: memoryBucket } as unknown as Env; app = new Hono(); app.route('/integration/v1', createIntegrationTokenRoutes()); app.route('/integration', createIntegrationTokenRoutes()); app.use('*', async (c, next) => { c.set('memberId', c.req.header('x-test-member')!); c.set('authTime', Date.now()); await next(); }); app.route('/', createSocialRoutes()); app.route('/', createIntegrationConsentRoutes()); }, 30000);
    afterAll(async () => { if (sql)
        await sql.end(); });
    it('bootstraps only the same authorized roster as devices, preserving the ordinary me shape', async () => {
        const viewer = await person(), unrelated = await person();
        const ordinary = (await request(viewer.id, '/me')).data;
        const bootstrap = (await request(viewer.id, '/me?bootstrap=1')).data;
        const devices = (await request(viewer.id, '/devices')).data;
        expect(bootstrap.startup_devices).toEqual(devices.items);
        expect(bootstrap.startup_devices.some((d: any) => d.id === unrelated.deviceId)).toBe(false);
        expect(bootstrap.startup_devices.some((d: any) => d.id === viewer.deviceId)).toBe(true);
        expect(bootstrap.startup_devices.every((d: any) => !('encrypted_private_key' in d))).toBe(true);
        const {startup_devices, ...account} = bootstrap;
        expect(account).toEqual(ordinary);
        expect(ordinary).not.toHaveProperty('startup_devices');
        expect(account.connection_count).toBe(0);
    });
    it('returns real database spans and connection counts to an opted-in traced member request', async () => {
        const viewer = await person();
        const traced = new Hono<{ Bindings: Env; Variables: Variables }>();
        traced.use('*', tracingMiddleware());
        traced.use('*', requestTimingMiddleware);
        traced.use('*', async (c, next) => { c.set('memberId', c.req.header('x-test-member')!); c.set('authTime', Date.now()); await next(); });
        traced.route('/api/v1', createSocialRoutes());
        const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        for (const path of ['/api/v1/feed', '/api/v1/me?bootstrap=1']) {
            const response = await traced.request('https://porchday.test' + path, { headers: { 'x-test-member': viewer.id, traceparent } }, env);
            expect(response.status).toBe(200);
            const header = response.headers.get('server-timing')!;
            expect(header).toContain('pd-trace;desc="4bf92f3577b34da6a3ce929d0e0e4736"');
            expect(header).toMatch(/pd-span;dur=[0-9.]+;desc="social_connect_begin@[0-9.]+"/);
            expect(header).toMatch(/pd-span;dur=[0-9.]+;desc="social_query@[0-9.]+"/);
            expect(header).toContain('pd-count;desc="db_conn_social=1"');
            expect(header).toContain('pd-route;desc="' + path.split('?')[0] + '"');
        }
        const untraced = await traced.request('https://porchday.test/api/v1/feed', { headers: { 'x-test-member': viewer.id } }, env);
        expect(untraced.headers.has('server-timing')).toBe(false);
    });
    it('shows invitation identities and status only to owners, paginates, and updates the latest inviter', async () => {
        const owner=await person(), moderator=await person(), recipient=await person(), outsider=await person();
        const handle=(p: Person) => 't_'+p.id.replaceAll('-','').slice(0,20);
        const group=await seal(owner,{name:'Invitation roster'},{kind:'group',audience:'only_me'}), groupId=group.context.id;
        expect((await request(owner.id,'/groups','POST',{envelope:group})).status).toBe(201);
        const invite=await request(owner.id,`/groups/${groupId}/invitations`,'POST',{handle:handle(moderator)});
        expect((await request(moderator.id,`/group-invitations/${invite.data.id}/accept`,'POST')).status).toBe(200);
        expect((await request(owner.id,`/groups/${groupId}/members/${moderator.id}`,'PUT',{role:'moderator'})).status).toBe(200);
        expect((await request(owner.id,`/groups/${groupId}/invitations`,'POST',{handle:handle(recipient)})).status).toBe(201);
        expect((await request(moderator.id,`/groups/${groupId}/invitations`,'POST',{handle:handle(recipient)})).status).toBe(201);
        let roster=await request(owner.id,`/groups/${groupId}/invitations`);
        expect(roster.status).toBe(200);
        expect(roster.data.items).toEqual(expect.arrayContaining([
            expect.objectContaining({recipient_handle:handle(recipient),inviter_handle:handle(moderator),accepted_at:null}),
            expect.objectContaining({recipient_handle:handle(moderator),inviter_handle:handle(owner),accepted_at:expect.any(String)})
        ]));
        expect(roster.data.items.every((i:any)=>!('envelope' in i)&&!('recipient' in i))).toBe(true);
        for(const p of [moderator,recipient,outsider]) expect((await request(p.id,`/groups/${groupId}/invitations`)).status).toBe(403);
        await sql`insert into app.blocks(actor,target) values(${owner.id},${recipient.id})`;
        roster=await request(owner.id,`/groups/${groupId}/invitations`);
        expect(roster.data.items.some((i:any)=>i.recipient_handle===null)).toBe(true);
        await sql`update app.group_invitations set expires_at=now()-interval '1 day' where group_id=${groupId} and recipient=${recipient.id}`;
        roster=await request(owner.id,`/groups/${groupId}/invitations`);
        expect(roster.data.items.some((i:any)=>!i.accepted_at&&Date.parse(i.expires_at)<Date.now())).toBe(true);
        for(let n=0;n<30;n++){
            const id=randomUUID();
            await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
            await sql`insert into app.profiles(member_id,handle) values(${id},${'inv_'+id.replaceAll('-','').slice(0,20)})`;
            await sql`insert into app.group_invitations(id,group_id,inviter,recipient) values(${randomUUID()},${groupId},${owner.id},${id})`;
        }
        await sql`update app.group_invitations set expires_at='2030-01-01T00:00:00.123456Z' where group_id=${groupId}`;
        roster=await request(owner.id,`/groups/${groupId}/invitations`);
        expect(roster.data.items).toHaveLength(30);
        const next=await request(owner.id,`/groups/${groupId}/invitations?cursor=${encodeURIComponent(roster.data.next_cursor)}`);
        expect(next.data.items).toHaveLength(2);
        expect(new Set([...roster.data.items,...next.data.items].map((i:any)=>i.id)).size).toBe(32);
        expect(next.data.next_cursor).toBeNull();
        expect((await request(owner.id,`/groups/${groupId}/members/${moderator.id}`,'PUT',{role:'owner'})).status).toBe(200);
        expect((await request(owner.id,`/groups/${groupId}/invitations`)).status).toBe(403);
        expect((await request(moderator.id,`/groups/${groupId}/invitations`)).status).toBe(200);
    },60000);
    it('includes authorized author handles on walls, post details and group posts', async () => {
        const author = await person(), viewer = await person(), outsider = await person();
        await connection(author, viewer);
        const [{handle}] = await sql`select handle from app.profiles where member_id=${author.id}`;
        const envelope = await seal(author, {text: 'Wall identity'});
        expect((await request(author.id, '/posts', 'POST', {envelope})).status).toBe(201);
        const expected = {id: envelope.context.id, author_id: author.id, author_handle: handle};
        expect((await request(viewer.id, '/walls/' + author.id)).data.items).toEqual([expect.objectContaining(expected)]);
        expect((await request(viewer.id, '/posts/' + envelope.context.id)).data.post).toMatchObject(expected);
        expect((await request(outsider.id, '/walls/' + author.id)).data.items).toEqual([]);
        expect((await request(outsider.id, '/posts/' + envelope.context.id)).status).toBe(404);
        const group = await seal(author, {name: 'Identity test'}, {kind: 'group', audience: 'only_me'});
        expect((await request(author.id, '/groups', 'POST', {envelope: group})).status).toBe(201);
        const groupPost = await seal(author, {text: 'Group identity'}, {audience: 'group', groupId: group.context.id});
        expect((await request(author.id, '/posts', 'POST', {envelope: groupPost})).status).toBe(201);
        expect((await request(author.id, '/groups/' + group.context.id + '/posts')).data.items).toEqual([
            expect.objectContaining({id: groupPost.context.id, author_handle: handle})
        ]);
        expect((await request(viewer.id, '/groups/' + group.context.id + '/posts')).data.items).toEqual([]);
    }, 60000);
    it('keeps labels private and directional across requests, acceptance, audiences and immediate changes', async()=>{
        const a=await person(),b=await person(),outsider=await person();
        const [profile]=await sql`select handle from app.profiles where member_id=${b.id}`;
        const pending=await request(a.id,'/connections/requests','POST',{handle:profile.handle,kind:'family',history:'full'});
        expect(pending.status).toBe(201);
        expect((await request(a.id,'/connections')).data.requests.find((r:any)=>r.id===pending.data.id)).toMatchObject({kind:'family'});
        expect((await request(b.id,'/connections')).data.requests.find((r:any)=>r.id===pending.data.id)).toMatchObject({kind:null});
        const accepted=await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST');
        expect(accepted.status).toBe(200);const edge=accepted.data.id;
        const own=async(p:Person)=>(await request(p.id,'/connections')).data.items.find((r:any)=>r.id===edge);
        const aEdge=await own(a),bEdge=await own(b);
        expect(aEdge).toMatchObject({kind:'family',own_history:'full',peer_history:'future'});
        expect(bEdge).toMatchObject({kind:'friend',own_history:'future',peer_history:'full'});
        for(const row of [aEdge,bEdge]) {
            expect(Object.keys(row).sort()).toEqual(['id','member_a','member_b','accepted_at','kind','own_history','peer_history'].sort());
        }
        expect((await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST',{kind:'family',history:'full'})).status).toBe(200);
        expect(await own(b)).toMatchObject({kind:'friend',own_history:'future'});
        const family=await seal(a,{text:'A classifies B as family'},{audience:'family'});
        expect((await request(a.id,'/posts','POST',{envelope:family})).status).toBe(201);
        expect((await request(b.id,'/posts/'+family.context.id)).status).toBe(200);
        const reverse=await seal(b,{text:'B classifies A as a friend'},{audience:'friends'});
        expect((await request(b.id,'/posts','POST',{envelope:reverse})).status).toBe(201);
        expect((await request(a.id,'/posts/'+reverse.context.id)).status).toBe(200);
        const stale=await seal(b,{text:'Old friends snapshot'},{audience:'friends'});
        expect((await request(b.id,'/connections/'+edge+'/kind','PUT',{kind:'family'})).status).toBe(200);
        expect((await request(b.id,'/posts','POST',{envelope:stale})).status).toBe(409);
        expect((await request(a.id,'/posts/'+reverse.context.id)).status).toBe(404);
        expect((await request(b.id,'/posts/'+family.context.id)).status).toBe(200);
        expect(await own(a)).toMatchObject({kind:'family'});
        const reverseFamily=await seal(b,{text:'New family audience'},{audience:'family'});
        expect((await request(b.id,'/posts','POST',{envelope:reverseFamily})).status).toBe(201);
        expect((await request(a.id,'/connections/'+edge+'/kind','PUT',{kind:'friend'})).status).toBe(200);
        expect((await request(b.id,'/posts/'+family.context.id)).status).toBe(404);
        expect((await request(a.id,'/posts/'+reverseFamily.context.id)).status).toBe(200);
        expect(await own(b)).toMatchObject({kind:'family'});
        expect((await request(outsider.id,'/connections/'+edge+'/kind','PUT',{kind:'friend'})).status).toBe(404);
        expect((await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST',{kind:'colleague'})).status).toBe(400);
        expect((await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST',{kind:'friend',kind_a:'family'})).status).toBe(400);
    },60000);
    it('lets an accepting member choose Family independently of the sender’s Friend label',async()=>{
        const a=await person(),b=await person();
        const [profile]=await sql`select handle from app.profiles where member_id=${b.id}`;
        const pending=await request(a.id,'/connections/requests','POST',{handle:profile.handle,kind:'friend'});
        const accepted=await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST',{kind:'family',history:'full'});
        expect(accepted.status).toBe(200);
        expect((await request(a.id,'/connections')).data.items.find((r:any)=>r.id===accepted.data.id)).toMatchObject({kind:'friend',own_history:'future'});
        expect((await request(b.id,'/connections')).data.items.find((r:any)=>r.id===accepted.data.id)).toMatchObject({kind:'family',own_history:'full'});
    },60000);
    it('keeps history consent directional, defaults old clients to future, and resets it on reconnect', async()=>{
        const a=await person(),b=await person(),outsider=await person();
        const [profile]=await sql`select handle from app.profiles where member_id=${b.id}`;
        const pending=await request(a.id,'/connections/requests','POST',{handle:profile.handle,kind:'friend',history:'full'});
        expect(pending.status).toBe(201);
        expect((await request(b.id,'/connections')).data.requests.find((r:any)=>r.id===pending.data.id).history).toBe('full');
        const accepted=await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST');
        expect(accepted.status).toBe(200);const edge=accepted.data.id;
        const own=async(p:Person)=>(await request(p.id,'/connections')).data.items.find((r:any)=>r.id===edge);
        expect(await own(a)).toMatchObject({own_history:'full',peer_history:'future'});
        expect(await own(b)).toMatchObject({own_history:'future',peer_history:'full'});
        // Acceptance retries cannot silently change either person's choice.
        expect((await request(b.id,'/connections/requests/'+pending.data.id+'/accept','POST',{history:'full'})).status).toBe(200);
        expect((await own(b)).own_history).toBe('future');
        expect((await request(outsider.id,'/connections/'+edge+'/history','PUT',{history:'full'})).status).toBe(404);
        expect((await request(b.id,'/connections/'+edge+'/history','PUT',{history:'full'})).status).toBe(200);
        expect(await own(a)).toMatchObject({own_history:'full',peer_history:'full'});
        expect((await request(a.id,'/connections/'+edge+'/history','PUT',{history:'future'})).status).toBe(200);
        expect(await own(a)).toMatchObject({own_history:'future',peer_history:'full'});
        expect((await sql`select decision from app.test_history_journal where decision->>'action'='connection' and decision->>'a'=${[a.id,b.id].sort()[0]} and decision->>'b'=${[a.id,b.id].sort()[1]}`)).toHaveLength(1);
        expect((await request(a.id,'/connections/'+edge,'DELETE')).status).toBe(200);
        await connection(a,b);
        expect((await request(a.id,'/connections')).data.items[0]).toMatchObject({own_history:'future',peer_history:'future'});
    },60000);
    it('refreshes author-signed history and immutable photos only for consented audiences, retaining original dates and hiding old children',async()=>{
        const owner=await person(),oldFriend=await person(),full=await person(),future=await person(),relative=await person(),outsider=await person();
        await connection(owner,oldFriend);
        const postId=randomUUID(),photoId=randomUUID(),deadline=new Date(Date.now()+3600000).toISOString(),photoDeadline=new Date(Date.now()+1800000).toISOString();
        const photoPayload={mime:'image/jpeg',bytes:'c2FtcGxl',alt:'History photo'};
        const photo=await seal(owner,photoPayload,{id:photoId,kind:'media',parentId:postId,audience:'friends',expiresAt:photoDeadline});
        const upload=async(p:Person,envelope:any,history?:{history_post_id:string;history_source_revision:number})=>{
            const bytes=new TextEncoder().encode(JSON.stringify(envelope));const reservation=await request(p.id,'/media','POST',{id:envelope.context.id,envelope,byte_size:bytes.length,...history});
            expect(reservation.status,JSON.stringify(reservation.data)).toBe(201);expect((await app.request('https://porchday.test/media/'+envelope.context.id+'/bytes',{method:'PUT',headers:{'x-test-member':p.id,'content-type':'application/octet-stream'},body:bytes},env)).status).toBe(200);
        };
        await upload(owner,photo);
        const payload={text:'Before friendship',media:[{id:photoId}],reactionSecret:createReactionSecret()};
        const original=await seal(owner,payload,{id:postId,audience:'friends',expiresAt:deadline});
        expect((await request(owner.id,'/posts','POST',{envelope:original,media_ids:[photoId]})).status).toBe(201);
        const child=await seal(oldFriend,{text:'Old comment'},{kind:'comment',audience:'friends',parentId:postId,expiresAt:deadline},postId);
        expect((await request(oldFriend.id,'/posts/'+postId+'/comments','POST',{envelope:child,parent_expires_at:deadline})).status).toBe(201);
        const tag=await reactionTag({secret:payload.reactionSecret,targetId:postId,memberId:oldFriend.id,emoji:'love'});
        const reaction=await seal(oldFriend,{emoji:'love'},{kind:'reaction',id:tag,audience:'friends',parentId:postId,expiresAt:deadline},postId);
        expect((await request(oldFriend.id,'/posts/'+postId+'/reactions/'+tag,'PUT',{envelope:reaction})).status).toBe(200);
        const relativePost=await seal(owner,{text:'Family only'},{audience:'family'}),privatePost=await seal(owner,{text:'Only me'},{audience:'only_me'});
        for(const envelope of [relativePost,privatePost])expect((await request(owner.id,'/posts','POST',{envelope})).status).toBe(201);
        for(const [peer,kind,history] of [[full,'friend','full'],[future,'friend','future'],[relative,'family','full']] as const){
            const [profile]=await sql`select handle from app.profiles where member_id=${peer.id}`;
            const invite=await request(owner.id,'/connections/requests','POST',{handle:profile.handle,kind,history});
            expect((await request(peer.id,'/connections/requests/'+invite.data.id+'/accept','POST',{history:'future'})).status).toBe(200);
        }
        const candidates=await request(owner.id,'/posts/audience-refresh');
        expect(candidates.status).toBe(200);expect(candidates.data.items.map((p:any)=>p.id)).toEqual(expect.arrayContaining([postId,relativePost.context.id]));
        expect(candidates.data.items.some((p:any)=>p.id===privatePost.context.id)).toBe(false);
        expect((await request(outsider.id,'/posts/'+postId+'/audience-refresh/audience')).status).toBe(404);
        expect((await request(oldFriend.id,'/posts/'+postId+'/audience-refresh/audience')).status).toBe(403);
        expect((await request(full.id,'/posts/'+postId)).status).toBe(404);
        const snap=(await request(owner.id,'/posts/'+postId+'/audience-refresh/audience')).data;
        expect(snap.devices.map((d:any)=>d.member_id).sort()).toEqual([owner.id,oldFriend.id,full.id].sort());
        const encrypt=async(context:ContentContext,value:unknown)=>encryptObject({context:{...context,epoch:snap.epoch},payload:value,signingKey:owner.key,recipients:snap.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
        const replacementId=randomUUID(),replacement=await encrypt({...photo.context,id:replacementId,createdAt:new Date().toISOString()},photoPayload);
        // Ordinary upload cannot bypass the history-specific consent snapshot.
        expect((await request(owner.id,'/media','POST',{id:replacementId,envelope:replacement,byte_size:new TextEncoder().encode(JSON.stringify(replacement)).length})).data.error.code).toBe('AUDIENCE_CHANGED');
        await upload(owner,replacement,{history_post_id:postId,history_source_revision:1});
        const envelope=await encrypt({...original.context,revision:2},{...payload,media:[{id:replacementId}]});
        const lifecycle=await signStatement({purpose:'porchday-lifecycle',id:postId,revision:2,expiresAt:deadline},owner.key);
        const refresh={envelope,lifecycle,source_revision:1,source_expires_at:deadline,source_media_ids:[photoId],media_ids:[replacementId]};
        expect((await request(owner.id,'/posts/'+postId+'/audience-refresh','POST',{...refresh,source_media_ids:[]})).data.error.code).toBe('MEDIA_ATTACHMENT_CHANGED');
        expect((await request(owner.id,'/posts/'+postId+'/audience-refresh','POST',{...refresh,lifecycle:await signStatement({purpose:'porchday-lifecycle',id:postId,revision:2,expiresAt:deadline},outsider.key)})).data.error.code).toBe('INVALID_PROOF');
        expect((await request(owner.id,'/posts/'+postId+'/audience-refresh','POST',refresh)).status).toBe(200);
        expect((await request(owner.id,'/posts/'+postId+'/audience-refresh','POST',refresh)).status).toBe(200);
        const detail=await request(full.id,'/posts/'+postId);
        expect(detail.status).toBe(200);expect(detail.data.post.envelope.context.createdAt).toBe(original.context.createdAt);expect(detail.data.post.edited_at).toBeNull();
        expect(detail.data.comments).toEqual([]);expect(detail.data.reactions).toEqual([]);
        expect((await request(oldFriend.id,'/posts/'+postId)).data.comments).toHaveLength(1);
        expect(await decryptObject({envelope:detail.data.post.envelope,expectedContext:envelope.context,privateKey:full.key,authorPublicKey:owner.publicKey})).toMatchObject({text:'Before friendship',media:[{id:replacementId}]});
        const bytes=await app.request('https://porchday.test/media/'+replacementId+'/bytes',{headers:{'x-test-member':full.id}},env);
        expect(bytes.status).toBe(200);expect(await decryptObject({envelope:await bytes.json() as any,expectedContext:replacement.context,privateKey:full.key,authorPublicKey:owner.publicKey})).toEqual(photoPayload);
        expect(await sql`select id from app.media_assets where id=${photoId}`).toHaveLength(0);
        expect(await sql`select * from app.deletion_outbox where object_key=${'media/'+owner.id+'/'+photoId}`).toHaveLength(1);
        for(const peer of [future,relative,outsider])expect((await request(peer.id,'/posts/'+postId)).status).toBe(404);
        expect((await request(owner.id,'/posts/audience-refresh')).data.items.some((p:any)=>p.id===postId)).toBe(false);
        const edge=(await request(owner.id,'/connections')).data.items.find((r:any)=>[r.member_a,r.member_b].includes(full.id));
        expect((await request(owner.id,'/connections/'+edge.id+'/history','PUT',{history:'future'})).status).toBe(200);
        // Going forward stops new backfill; it does not recall delivered posts.
        expect((await request(full.id,'/posts/'+postId)).status).toBe(200);
        expect((await request(owner.id,'/blocks/'+full.id,'PUT')).status).toBe(200);
        expect((await request(full.id,'/posts/'+postId)).status).toBe(404);
        expect((await request(owner.id,'/blocks/'+full.id,'DELETE')).status).toBe(200);
        await connection(owner,full);
        expect((await request(owner.id,'/posts/'+postId+'/audience-refresh/audience')).data.devices.some((d:any)=>d.member_id===full.id)).toBe(false);
    },90000);
    it('rejects stale history snapshots, source revisions and expired posts without changing their grants',async()=>{
        const a=await person(),b=await person();
        const post=await seal(a,{text:'Race fixture'}),timed=await seal(a,{text:'Expired fixture'},{expiresAt:new Date(Date.now()+60000).toISOString()});
        for(const envelope of [post,timed])expect((await request(a.id,'/posts','POST',{envelope})).status).toBe(201);
        await connection(a,b);const edge=(await request(a.id,'/connections')).data.items[0];
        expect((await request(a.id,'/posts/audience-refresh')).data.items).toEqual([]);
        await request(a.id,'/connections/'+edge.id+'/history','PUT',{history:'full'});
        const snap=(await request(a.id,'/posts/'+post.context.id+'/audience-refresh/audience')).data;
        const envelope=await encryptObject({context:{...post.context,epoch:snap.epoch,revision:2},payload:{text:'Race fixture'},signingKey:a.key,recipients:snap.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
        const lifecycle=await signStatement({purpose:'porchday-lifecycle',id:post.context.id,revision:2,expiresAt:null},a.key);
        const refresh={envelope,lifecycle,source_revision:1,source_expires_at:null,source_media_ids:[],media_ids:[]};
        await request(a.id,'/connections/'+edge.id+'/history','PUT',{history:'future'});
        expect((await request(a.id,'/posts/'+post.context.id+'/audience-refresh','POST',refresh)).data.error.code).toBe('AUDIENCE_CHANGED');
        expect((await request(b.id,'/posts/'+post.context.id)).status).toBe(404);
        const edited=await seal(a,{text:'Concurrent edit'},{...post.context,revision:2},post.context.id);
        expect((await request(a.id,'/posts/'+post.context.id,'PUT',{envelope:edited,lifecycle})).status).toBe(200);
        expect((await request(a.id,'/posts/'+post.context.id+'/audience-refresh','POST',refresh)).data.error.code).toBe('REVISION_CHANGED');
        await sql`update app.posts set expires_at=created_at+interval '1 millisecond' where id=${timed.context.id}`;
        await request(a.id,'/connections/'+edge.id+'/history','PUT',{history:'full'});
        expect((await request(a.id,'/posts/audience-refresh')).data.items.some((p:any)=>p.id===timed.context.id)).toBe(false);
        expect((await request(a.id,'/posts/'+timed.context.id+'/audience-refresh/audience')).status).toBe(404);
    },60000);
    it('keeps friends-only posts, replies, reactions and photos from family while retaining eligible non-mutual commenters', async () => {
        const owner = await person(), friend = await person(), peer = await person(), relative = await person();
        await connection(owner, friend); await connection(owner, peer); await connection(owner, relative, 'family');
        const snapshot = await request(owner.id, '/audiences?audience=friends');
        expect(snapshot.data.devices.map((d: any) => d.member_id).sort()).toEqual([owner.id, friend.id, peer.id].sort());
        const postId = randomUUID(), mediaId = randomUUID(), secret = createReactionSecret();
        const photo = await seal(owner, {mime: 'image/jpeg', bytes: 'c2FtcGxl', alt: 'Friends fixture'}, {id: mediaId, kind: 'media', audience: 'friends', parentId: postId});
        const bytes = new TextEncoder().encode(JSON.stringify(photo));
        expect((await request(owner.id, '/media', 'POST', {id: mediaId, envelope: photo, byte_size: bytes.length})).status).toBe(201);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {method: 'PUT', headers: {'x-test-member': owner.id, 'content-type': 'application/octet-stream'}, body: bytes}, env)).status).toBe(200);
        const post = await seal(owner, {text: 'Friends, excluding family', reactionSecret: secret, media: [{id: mediaId}]}, {id: postId, audience: 'friends'});
        expect((await request(owner.id, '/posts', 'POST', {envelope: post, media_ids: [mediaId]})).status).toBe(201);
        const reply = await seal(peer, {text: 'A fellow friend replied'}, {kind: 'comment', audience: 'friends', parentId: postId}, postId);
        expect((await request(peer.id, '/posts/' + postId + '/comments', 'POST', {envelope: reply, parent_expires_at: null})).status).toBe(201);
        const nested = await seal(friend, {text: 'Nested reply'}, {kind: 'comment', audience: 'friends', parentId: reply.context.id}, postId);
        expect((await request(friend.id, '/posts/' + postId + '/comments', 'POST', {envelope: nested, parent_expires_at: null})).status).toBe(201);
        for (const [kind, target] of [['posts', postId], ['comments', reply.context.id]]) {
            const tag = await reactionTag({secret, targetId: target, memberId: friend.id, emoji: 'like'});
            const reaction = await seal(friend, {emoji: 'like'}, {id: tag, kind: 'reaction', audience: 'friends', parentId: target}, postId);
            expect((await request(friend.id, `/${kind}/${target}/reactions/${tag}`, 'PUT', {envelope: reaction})).status).toBe(200);
        }
        const detail = await request(friend.id, '/posts/' + postId);
        expect(detail.status).toBe(200); expect(detail.data.comments).toHaveLength(2);
        expect(detail.data.reactions).toHaveLength(1); expect(detail.data.comment_reactions).toHaveLength(1);
        expect(await decryptObject({envelope: reply, expectedContext: reply.context, privateKey: friend.key, authorPublicKey: peer.publicKey})).toEqual({text: 'A fellow friend replied'});
        await expect(decryptObject({envelope: post, expectedContext: post.context, privateKey: relative.key, authorPublicKey: owner.publicKey})).rejects.toThrow('not a recipient');
        expect((await request(relative.id, '/posts/' + postId)).status).toBe(404);
        expect((await request(relative.id, '/audiences?audience=friends&post_id=' + postId)).status).toBe(404);
        expect((await request(relative.id, '/feed')).data.items.some((p: any) => p.id === postId)).toBe(false);
        expect((await request(relative.id, '/walls/' + owner.id)).data.items.some((p: any) => p.id === postId)).toBe(false);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {headers: {'x-test-member': relative.id}}, env)).status).toBe(404);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {headers: {'x-test-member': friend.id}}, env)).status).toBe(200);
        const profile = await seal(owner, {displayName: 'Narrow profile is not supported'}, {id: owner.id, kind: 'profile', audience: 'friends'});
        expect((await request(owner.id, '/profiles/me', 'PUT', {envelope: profile})).data.error.code).toBe('ENVELOPE_CONTEXT');
        const stale = await seal(owner, {text: 'Snapshot before friend becomes family'}, {audience: 'friends'});
        const [edge] = await sql`select id from app.connections where ${owner.id} in(member_a,member_b) and ${friend.id} in(member_a,member_b)`;
        for (const member of [owner, friend]) expect((await request(member.id, '/connections/' + edge.id + '/kind', 'PUT', {kind: 'family'})).status).toBe(200);
        expect((await request(owner.id, '/posts', 'POST', {envelope: stale})).data.error.code).toBe('AUDIENCE_CHANGED');
        expect((await request(friend.id, '/posts/' + postId)).status).toBe(404);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {headers: {'x-test-member': friend.id}}, env)).status).toBe(404);
        expect((await request(peer.id, '/posts/' + postId)).status).toBe(200);
    }, 60000);
    it('imports private posts and photos through the restricted role without RETURNING visibility, and retries without duplicate rows or attachments', async () => {
        const owner = await person(), stranger = await person();
        const postId = randomUUID(), mediaId = randomUUID(), source = 'archive:' + randomUUID();
        const post = await seal(owner, {text: 'Private imported photo', media: [{id: mediaId}]}, {id: postId, audience: 'only_me'});
        const media = await seal(owner, {mime: 'image/jpeg', bytes: 'c2FtcGxl', alt: 'Imported fixture'}, {id: mediaId, kind: 'media', audience: 'only_me', parentId: postId});
        const bytes = new TextEncoder().encode(JSON.stringify(media));
        expect((await request(owner.id, '/media', 'POST', {id: mediaId, envelope: media, byte_size: bytes.length})).status).toBe(201);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {method: 'PUT', headers: {'x-test-member': owner.id, 'content-type': 'application/octet-stream'}, body: bytes}, env)).status).toBe(200);
        const transfer = randomUUID();
        const created = await request(owner.id, '/imports', 'POST', {id: transfer, posts: [{envelope: post, source_id: source, media_ids: [mediaId]}]});
        expect(created).toEqual({status: 201, data: {id: transfer, imported: [postId]}});
        expect((await request(owner.id, '/posts/' + postId)).status).toBe(200);
        expect((await request(stranger.id, '/posts/' + postId)).status).toBe(404);
        expect((await sql`select post_id,state from app.media_assets where id=${mediaId}`)[0]).toMatchObject({post_id: postId, state: 'attached'});
        const [recipient] = await sql`select count(*)::int n from app.post_recipients where post_id=${postId}`;
        expect(recipient.n).toBe(1);
        const retryPost = await seal(owner, {text: 'Must not replace first import'}, {audience: 'only_me'});
        const retried = await request(owner.id, '/imports', 'POST', {id: transfer, posts: [{envelope: retryPost, source_id: source, media_ids: [mediaId]}]});
        expect(retried).toEqual({status: 201, data: {id: transfer, imported: []}});
        expect(await sql`select id from app.posts where id=${retryPost.context.id}`).toHaveLength(0);
        expect((await sql`select count(*)::int n from app.posts where author_id=${owner.id} and import_source=${source}`)[0].n).toBe(1);
        expect((await sql`select post_id from app.media_assets where id=${mediaId}`)[0].post_id).toBe(postId);
        const collision = await seal(owner, {text: 'A conflicting ID is not an imported-source retry'}, {id: postId, audience: 'only_me'});
        expect((await request(owner.id, '/imports', 'POST', {id: randomUUID(), posts: [{envelope: collision, source_id: 'archive:' + randomUUID()}]})).status).toBe(409);
        const invalid = await seal(owner, {text: 'Must roll back missing attachment'}, {audience: 'only_me'});
        expect((await request(owner.id, '/imports', 'POST', {id: randomUUID(), posts: [{envelope: invalid, source_id: 'archive:' + randomUUID(), media_ids: [randomUUID()]}]})).status).toBe(409);
        expect(await sql`select id from app.posts where id=${invalid.context.id}`).toHaveLength(0);
    });
    it('preserves a committed upload after an ambiguous COMMIT response even when an account hold hides it under RLS',async()=>{
        const a=await person(),mediaId=randomUUID();
        const envelope=await seal(a,{mime:'image/jpeg',bytes:'c2FtcGxl',alt:'Ambiguous commit fixture'},{id:mediaId,kind:'media',parentId:a.id});
        const bytes=new TextEncoder().encode(JSON.stringify(envelope)),key='media/'+a.id+'/'+mediaId;
        expect((await request(a.id,'/media','POST',{id:mediaId,envelope,byte_size:bytes.length})).status).toBe(201);
        const original=database.withMember;let calls=0;
        const intercepted=vi.spyOn(database,'withMember').mockImplementation(async(env,member,work)=>{
            const result=await original(env,member,work);
            if(member===a.id&&++calls===3){await sql`update app.members set status='hold' where id=${a.id}`;throw Error('Synthetic lost COMMIT response');}
            return result;
        });
        try{
            const response=await app.request('https://porchday.test/media/'+mediaId+'/bytes',{method:'PUT',headers:{'x-test-member':a.id,'content-type':'application/octet-stream'},body:bytes},env);
            expect(response.status).toBe(503);expect({calls,stored:objects.has(key),state:(await sql`select state from app.media_assets where id=${mediaId}`)[0]?.state,status:(await sql`select status from app.members where id=${a.id}`)[0]?.status}).toEqual({calls:4,stored:true,state:'ready',status:'hold'});
            expect((await sql`select state from app.media_assets where id=${mediaId}`)[0].state).toBe('ready');
            const state=await original(env,a.id,async db=>({visible:await db`select state from app.media_assets where id=${mediaId}`,cleanup:(await db`select app.lock_media_upload_cleanup(${mediaId}) as state`)[0].state}));
            expect(state.visible).toHaveLength(0);expect(state.cleanup).toBe('ready');
            const stranger=await person();expect(await original(env,stranger.id,async db=>(await db`select app.lock_media_upload_cleanup(${mediaId}) as state`)[0].state)).toBe('unavailable');
        }finally{intercepted.mockRestore();}
    });
    it('cleans an upload whose reservation is deleted during streaming and confirms absence again after the bounded late-writer window',async()=>{
        const a=await person(),mediaId=randomUUID();
        const envelope=await seal(a,{mime:'image/jpeg',bytes:'c2FtcGxl',alt:'Deleted stream fixture'},{id:mediaId,kind:'media',parentId:a.id});
        const bytes=new TextEncoder().encode(JSON.stringify(envelope)),key='media/'+a.id+'/'+mediaId;
        expect((await request(a.id,'/media','POST',{id:mediaId,envelope,byte_size:bytes.length})).status).toBe(201);
        const jobs={HYPERDRIVE_JOBS:{connectionString:url!},MEDIA:memoryBucket} as unknown as Env;
        const intercepted=vi.spyOn(memoryBucket,'put').mockImplementation(async(k,body)=>{
            const buffered=await new Response(body).arrayBuffer();
            await sql`delete from app.media_assets where id=${mediaId}`;
            await database.cleanupExpired(jobs); // Outbox runs before the final storage write.
            expect((await sql`select completed_at from app.deletion_outbox where object_key=${key}`)[0].completed_at).toBeNull();
            objects.set(k,buffered);return objectMetadata(k);
        });
        try{
            const response=await app.request('https://porchday.test/media/'+mediaId+'/bytes',{method:'PUT',headers:{'x-test-member':a.id,'content-type':'application/octet-stream'},body:bytes},env);
            expect(response.status).toBe(404);expect(objects.has(key)).toBe(false);
            // Model process death after the late R2 write, before handler cleanup.
            objects.set(key,bytes.buffer);await sql`update app.deletion_outbox set created_at=now()-interval '11 minutes',next_retry=now() where object_key=${key}`;
            await database.cleanupExpired(jobs);expect(objects.has(key)).toBe(false);
            expect((await sql`select completed_at from app.deletion_outbox where object_key=${key}`)[0].completed_at).not.toBeNull();
        }finally{intercepted.mockRestore();}
    });
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
    it('denies integration media bytes immediately at their own deadline while preserving surviving owned photos',async()=>{
        const a=await person(),mediaId=randomUUID(),liveId=randomUUID(),deadline=new Date(Date.now()+60_000).toISOString();
        for(const [id,expiresAt] of [[mediaId,deadline],[liveId,null]] as const){
            const envelope=await seal(a,{mime:'image/jpeg',bytes:'c2FtcGxl',alt:'Integration expiry fixture'},{id,kind:'media',parentId:a.id,audience:'only_me',expiresAt});
            const bytes=new TextEncoder().encode(JSON.stringify(envelope));
            expect((await request(a.id,'/media','POST',{id,envelope,byte_size:bytes.length})).status).toBe(201);
            expect((await app.request('https://porchday.test/media/'+id+'/bytes',{method:'PUT',headers:{'x-test-member':a.id,'content-type':'application/octet-stream'},body:bytes},env)).status).toBe(200);
        }
        const client=await request(a.id,'/integrations/clients','POST',{name:'Expiry test',purpose:'Read owned photo ciphertext',redirect_uri:'https://migration.example/callback'}),verifier='B'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
        const grant=await request(a.id,'/integrations/authorize','POST',{client_id:client.data.id,redirect_uri:'https://migration.example/callback',scope:['media:read'],code_challenge:challenge,code_challenge_method:'S256',state:'media-expiry-test-state',consent:true});
        const token=await request('', '/integration/token','POST',{grant_type:'authorization_code',client_id:client.data.id,redirect_uri:'https://migration.example/callback',code:new URL(grant.data.redirect_uri).searchParams.get('code'),code_verifier:verifier});expect(token.status).toBe(200);
        const headers={authorization:'Bearer '+token.data.access_token},read=(id:string)=>app.request('https://porchday.test/integration/own/media/'+id+'/bytes',{headers},env);
        expect((await read(mediaId)).status).toBe(200);
        // Owner fixture simulates time passage without deleting ciphertext or
        // waiting for cleanup; ordinary clients cannot make unsigned changes.
        await sql`update app.media_assets set envelope=jsonb_set(envelope,'{context,expiresAt}',to_jsonb((now()-interval '1 second')::text)) where id=${mediaId}`;
        expect(objects.has('media/'+a.id+'/'+mediaId)).toBe(true);
        const bucketRead=vi.spyOn(memoryBucket,'get');
        try{expect((await read(mediaId)).status).toBe(401);expect(bucketRead).not.toHaveBeenCalled();}
        finally{bucketRead.mockRestore();}
        expect((await read(liveId)).status).toBe(200);
        const page=await(await app.request('https://porchday.test/integration/own/media',{headers},env)).json();expect(page.media.map((m:any)=>m.id)).toEqual([liveId]);
    },30000);
    it('persists per-grant token attempts, rotates refresh credentials and bounds concurrent read requests',async()=>{
        const a=await person(),client=await request(a.id,'/integrations/clients','POST',{name:'Limits test',purpose:'Read own profile ciphertext',redirect_uri:'https://migration.example/callback'}),verifier='C'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
        const grant=await request(a.id,'/integrations/authorize','POST',{client_id:client.data.id,redirect_uri:'https://migration.example/callback',scope:['profile:read'],code_challenge:challenge,code_challenge_method:'S256',state:'rate-limit-test-state',consent:true});
        const exchange={grant_type:'authorization_code',client_id:client.data.id,redirect_uri:'https://migration.example/callback',code:new URL(grant.data.redirect_uri).searchParams.get('code'),code_verifier:verifier};
        for(let n=0;n<2;n++)expect((await request('','/integration/v1/token','POST',{...exchange,code_verifier:'D'.repeat(43)})).status).toBe(401);
        expect(Number((await sql`select sum(count) as n from app.integration_rate_limits where grant_id=${grant.data.grant_id} and operation='token'`)[0].n)).toBe(2);
        const token=await request('','/integration/v1/token','POST',exchange);expect(token.status).toBe(200);
        const refreshed=await request('','/integration/v1/token','POST',{grant_type:'refresh_token',client_id:client.data.id,refresh_token:token.data.refresh_token});expect(refreshed.status).toBe(200);
        expect((await request('','/integration/v1/token','POST',{grant_type:'refresh_token',client_id:client.data.id,refresh_token:token.data.refresh_token})).status).toBe(401);
        expect((await app.request('https://porchday.test/integration/v1/own/profile',{headers:{authorization:'Bearer '+token.data.access_token}},env)).status).toBe(401);
        // Seed both sides of a possible minute boundary; each bucket has only
        // two remaining slots, even if the concurrent batch straddles a minute.
        for(const operation of ['read','token'])await sql`insert into app.integration_rate_limits(grant_id,bucket,operation,count) select ${grant.data.grant_id},floor(extract(epoch from now())/60)::bigint+d,${operation},${operation==='read'?118:10} from generate_series(0,1) d on conflict(grant_id,bucket,operation) do update set count=excluded.count`;
        const headers={authorization:'Bearer '+refreshed.data.access_token};
        const reads=await Promise.all(Array.from({length:8},()=>app.request('https://porchday.test/integration/v1/own/profile',{headers},env)));
        const readCounters=await sql`select count from app.integration_rate_limits where grant_id=${grant.data.grant_id} and operation='read'`;
        const allowed=readCounters.reduce((n,r)=>n+Math.min(r.count-118,2),0);
        expect(allowed).toBeGreaterThanOrEqual(2);expect(allowed).toBeLessThanOrEqual(4);
        expect(reads.filter(r=>r.status===200)).toHaveLength(allowed);expect(reads.filter(r=>r.status===429)).toHaveLength(8-allowed);
        expect(readCounters.every(r=>r.count<=121)).toBe(true);
        for(const response of reads.filter(r=>r.status===429)){expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(60);expect((await response.json()).error.code).toBe('RATE_LIMIT');}
        const limited=await app.request('https://porchday.test/integration/v1/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',client_id:client.data.id,refresh_token:refreshed.data.refresh_token})},env);expect(limited.status).toBe(429);expect(limited.headers.get('Retry-After')).toBeTruthy();
        await sql`update app.integration_rate_limits set count=1 where grant_id=${grant.data.grant_id} and operation='token'`;
        const retried=await request('','/integration/v1/token','POST',{grant_type:'refresh_token',client_id:client.data.id,refresh_token:refreshed.data.refresh_token});expect(retried.status).toBe(200);
        await sql`update app.integration_grants set revoked_at=now() where id=${grant.data.grant_id}`;
        expect((await app.request('https://porchday.test/integration/v1/own/profile',{headers:{authorization:'Bearer '+retried.data.access_token}},env)).status).toBe(401);
        await expect(database.withMember(env,a.id,db=>db`select * from app.integration_rate_limits`)).rejects.toMatchObject({code:'42501'});
    },30000);
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
    it('atomically removes a reviewed profile photo, rejects replacements, and clears already empty slots', async () => {
        const a = await person(), mediaId = randomUUID();
        const photo = await seal(a, {mime: 'image/jpeg', bytes: 'c2FtcGxl'}, {id: mediaId, kind: 'media', parentId: a.id});
        const bytes = new TextEncoder().encode(JSON.stringify(photo));
        expect((await request(a.id, '/media', 'POST', {id: mediaId, envelope: photo, byte_size: bytes.length})).status).toBe(201);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {method: 'PUT', headers: {'x-test-member': a.id, 'content-type': 'application/octet-stream'}, body: bytes}, env)).status).toBe(200);
        const profile = await seal(a, {avatar: {id: mediaId}}, {id: a.id, kind: 'profile'});
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: profile})).status).toBe(200);
        expect((await request(a.id, '/media/' + mediaId + '/attachment', 'PUT', {kind: 'profile', target_id: a.id, slot: 'avatar'})).status).toBe(200);
        const stale = await seal(a, {avatar: null}, {...profile.context});
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: stale, remove_media: [{id: mediaId, slot: 'avatar'}]})).data.error.code).toBe('REVISION_CHANGED');
        expect(await sql`select id from app.media_assets where id=${mediaId}`).toHaveLength(1);
        expect(await sql`select id from app.deletion_outbox where object_key=${'media/' + a.id + '/' + mediaId}`).toHaveLength(0);
        const edited = await seal(a, {avatar: null}, {...profile.context, revision: 2});
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: edited, remove_media: [{id: randomUUID(), slot: 'avatar'}]})).data.error.code).toBe('MEDIA_ATTACHMENT_CHANGED');
        expect((await sql`select envelope from app.profiles where member_id=${a.id}`)[0].envelope).toEqual(profile);
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: edited, remove_media: [{id: mediaId, slot: 'avatar'}]})).status).toBe(200);
        expect(await sql`select id from app.media_assets where id=${mediaId}`).toHaveLength(0);
        expect(await sql`select id from app.deletion_outbox where object_key=${'media/' + a.id + '/' + mediaId}`).toHaveLength(1);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {headers: {'x-test-member': a.id}}, env)).status).toBe(404);
        const empty = await seal(a, {avatar: null, bio: 'Cleared an expired reference'}, {...profile.context, revision: 3});
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: empty, remove_media: [{id: mediaId, slot: 'avatar'}]})).status).toBe(200);
        expect((await request(a.id, '/profiles/me', 'PUT', {envelope: empty, remove_media: [{id: mediaId, slot: 'image'}]})).status).toBe(400);
    }, 30_000);
    it('lets a group manager remove another editor image with a signed revision while denying ordinary members', async () => {
        const owner = await person(), editor = await person(), reader = await person();
        const initial = await seal(owner, {name: 'Photo group'}, {kind: 'group', audience: 'only_me'}), groupId = initial.context.id;
        expect((await request(owner.id, '/groups', 'POST', {envelope: initial})).status).toBe(201);
        for (const participant of [editor, reader]) {
            const [{handle}] = await sql`select handle from app.profiles where member_id=${participant.id}`;
            const invite = await request(owner.id, '/groups/' + groupId + '/invitations', 'POST', {handle});
            expect(invite.status).toBe(201);
            expect((await request(participant.id, '/group-invitations/' + invite.data.id + '/accept', 'POST')).status).toBe(200);
        }
        expect((await request(owner.id, '/groups/' + groupId + '/members/' + editor.id, 'PUT', {role: 'moderator'})).status).toBe(200);
        const mediaId = randomUUID(), context = {id: groupId, kind: 'group' as const, audience: 'group' as const, groupId, revision: 2};
        const group = await seal(editor, {name: 'Photo group', image: {id: mediaId}}, context);
        expect((await request(editor.id, '/groups/' + groupId, 'PUT', {envelope: group})).status).toBe(200);
        const photo = await seal(editor, {mime: 'image/jpeg', bytes: 'c2FtcGxl'}, {kind: 'media', id: mediaId, audience: 'group', groupId, parentId: groupId});
        const bytes = new TextEncoder().encode(JSON.stringify(photo));
        expect((await request(editor.id, '/media', 'POST', {id: mediaId, envelope: photo, byte_size: bytes.length})).status).toBe(201);
        expect((await app.request('https://porchday.test/media/' + mediaId + '/bytes', {method: 'PUT', headers: {'x-test-member': editor.id, 'content-type': 'application/octet-stream'}, body: bytes}, env)).status).toBe(200);
        expect((await request(editor.id, '/media/' + mediaId + '/attachment', 'PUT', {kind: 'group', target_id: groupId, slot: 'image'})).status).toBe(200);
        const denied = await seal(reader, {name: 'Photo group'}, {...context, revision: 3});
        expect((await request(reader.id, '/groups/' + groupId, 'PUT', {envelope: denied, remove_media: [{id: mediaId, slot: 'image'}]})).status).toBe(403);
        expect(await sql`select id from app.media_assets where id=${mediaId}`).toHaveLength(1);
        const removed = await seal(owner, {name: 'Photo group'}, {...context, revision: 3});
        expect((await request(owner.id, '/groups/' + groupId, 'PUT', {envelope: removed, remove_media: [{id: mediaId, slot: 'image'}]})).status).toBe(200);
        expect(await sql`select id from app.media_assets where id=${mediaId}`).toHaveLength(0);
        expect(await sql`select id from app.deletion_outbox where object_key=${'media/' + editor.id + '/' + mediaId}`).toHaveLength(1);
        expect((await sql`select envelope from app.groups where id=${groupId}`)[0].envelope).toEqual(removed);
    }, 30_000);
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
