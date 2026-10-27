import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { fingerprint, verifyDeviceAuthorization, verifyStatement, validateEncryptedPrivateKey, canonicalJson, type EncryptedEnvelope } from '@porchday/crypto';
import { withMember, type Db } from './db.js';
import {feedTiming} from './feed-timing';
import { envelopeSchema } from './social-contract.js';
import { registerMediaRoutes } from './social-media.js';
import { registerExportRoutes } from './social-exports.js';
import { registerEmojiRoutes } from './social-emoji.js';
import { registerPushRoutes } from './social-push.js';
import { registerNativePushRoutes } from './social-native-push.js';
import type { Env, Variables } from './types.js';
type C = Context<{
    Bindings: Env;
    Variables: Variables;
}>;
const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const envelopeBody = z.object({ envelope: envelopeSchema });
const historyMode = z.enum(['full', 'future']);
const mediaIds = z.array(uuid).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate photo IDs');
const surfaceRemovals = (slots: [string, ...string[]], maximum: number) => z.array(z.object({id: uuid, slot: z.enum(slots)}).strict()).max(maximum)
    .refine(items => new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.slot)).size === items.length, 'Each photo and slot may be removed once').default([]);
class SocialError extends Error {
    constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 413 | 429 = 400, readonly details?: unknown) { super(code); }
}
function fail(code: string, status: 400 | 403 | 404 | 409 | 413 | 429 = 400, details?: unknown): never { throw new SocialError(code, status, details); }
function id(raw: string | undefined): string { return uuid.parse(raw); }
function recent(c: C): void { if (Date.now() - c.get('authTime') > 15 * 60000)
    fail('RECENT_AUTH_REQUIRED', 403); }
function iso(value: unknown): string | null { return value ? new Date(value as string).toISOString() : null; }
function cursor(raw?: string): {
    at: string;
    id: string;
} | null { if (!raw)
    return null; try {
    const v = JSON.parse(atob(raw));
    return { at: date.parse(v.at), id: uuid.parse(v.id) };
}
catch {
    fail('INVALID_CURSOR');
} }
function page(rows: any[], limit = 30) { const hasMore = rows.length > limit; const items = rows.slice(0, limit); const last = items.at(-1); return { items, next_cursor: hasMore && last ? btoa(JSON.stringify({ at: iso(last.created_at), id: last.id })) : null }; }
async function body<T>(c: C, schema: z.ZodType<T>, maxBytes = 2500000, allowEmpty = false): Promise<T> { const declared = Number(c.req.header('content-length') ?? 0); if (declared > maxBytes)
    fail('PAYLOAD_TOO_LARGE', 413); const raw = await c.req.text(); if (new TextEncoder().encode(raw).byteLength > maxBytes)
    fail('PAYLOAD_TOO_LARGE', 413); return schema.parse(allowEmpty && !raw ? {} : JSON.parse(raw)); }
async function tx<T>(c: C, fn: (db: Db) => Promise<T>): Promise<T> { return withMember(c.env, c.get('memberId'), fn, feedTiming(c.env,c.req.method,c.req.path)); }
async function writeAllowed(db: Db): Promise<void> { const [r] = await db `select app.may_write() as allowed`; if (!r?.allowed)
    fail('SOCIAL_RESTRICTED', 403); }
async function snapshot(db: Db, audience: string, groupId: string | null = null, postId: string | null = null, historyPostId: string | null = null) { const [r] = await db `select app.lock_epoch() as epoch`; if (!r)
    fail('FORBIDDEN', 403); if (historyPostId) {
    const devices = await db`select * from app.history_audience_devices(${historyPostId})`;
    const members = await db`select member_id from app.history_audience_members(${historyPostId})`;
    const keyed=new Set(devices.map(device=>device.member_id));const pending=members.filter(member=>!keyed.has(member.member_id));
    return {epoch:Number(r.epoch),devices,pending_members:pending.map(row=>row.member_id)};
} if (audience === 'moderators') {
    const staff = await db `select * from app.moderator_devices()`;
    if (!staff.length)
        fail('MODERATION_NOT_CONFIGURED', 409);
    const own = await db `select * from app.audience_devices('only_me',null,null)`;
    const devices = [...new Map([...own, ...staff].map(d => [d.id, d])).values()].sort((a, b) => a.id.localeCompare(b.id));
    return { epoch: Number(r.epoch), devices, pending_members: [] };
} const devices = await db `select * from app.audience_devices(${audience},${groupId}::uuid,${postId}::uuid)`; const pending = await db `select member_id from app.pending_audience_members(${audience},${groupId}::uuid,${postId}::uuid)`; return { epoch: Number(r.epoch), devices, pending_members: pending.map(r => r.member_id) }; }
async function checkEnvelope(db: Db, member: string, envelope: Pick<EncryptedEnvelope,'context'|'recipients'>, kind: string, options: {
    postId?: string;
    skipEpoch?: boolean;
    allowPast?: boolean;
    historyPostId?: string;
    historySourceRevision?: number;
} = {}) {
    const e = envelope.context;
    if ((kind === 'report') !== (e.audience === 'moderators'))
        fail('ENVELOPE_CONTEXT');
    if (e.authorId !== member || e.kind !== kind)
        fail('ENVELOPE_CONTEXT');
    // Profiles currently support the whole connection circle or the owner only.
    // Narrow post audiences must not inherit the broader profile read policy.
    if (kind === 'profile' && !['connections', 'only_me'].includes(e.audience))
        fail('ENVELOPE_CONTEXT');
    if (Date.parse(e.createdAt) > Date.now() + 300000 || (!options.allowPast && Date.parse(e.createdAt) < Date.now() - 600000))
        fail('INVALID_CREATION_TIME');
    if (e.expiresAt && (Date.parse(e.expiresAt) <= Date.now() || Date.parse(e.expiresAt) <= Date.parse(e.createdAt)))
        fail('EXPIRED');
    const [author] = await db `select id,fingerprint from app.device_keys where id=${e.authorDeviceId} and member_id=${member} and revoked_at is null`;
    if (!author)
        fail('DEVICE_NOT_TRUSTED', 403);
    if (options.historyPostId) {
        const source = await requirePost(db, options.historyPostId, true);
        if (source.author_id !== member || source.group_id !== null || !['connections','friends','family'].includes(source.audience) || e.audience !== source.audience || e.groupId !== null || (kind === 'post' ? e.id !== source.id : kind !== 'media' || e.parentId !== source.id)) fail('ENVELOPE_CONTEXT');
        if (options.historySourceRevision !== undefined && source.envelope.context.revision !== options.historySourceRevision) fail('REVISION_CHANGED',409);
    }
    const s = await snapshot(db, e.audience, e.groupId, options.postId ?? null, options.historyPostId ?? null);
    if (s.pending_members.length)
        fail('KEY_SETUP_REQUIRED', 409, { pending_members: s.pending_members });
    if (!options.skipEpoch && e.epoch !== s.epoch)
        fail('AUDIENCE_CHANGED', 409, { epoch: s.epoch });
    const actual = envelope.recipients.map(r => `${r.deviceId}:${r.memberId}:${r.fingerprint}`).sort();
    const expected = s.devices.map(r => `${r.id}:${r.member_id}:${r.fingerprint}`).sort();
    if (canonicalJson(actual) !== canonicalJson(expected))
        fail('AUDIENCE_CHANGED', 409, { epoch: s.epoch });
    if (!envelope.recipients.some(r => r.deviceId === e.authorDeviceId && r.memberId === member && r.fingerprint === author.fingerprint))
        fail('AUTHOR_NOT_RECIPIENT');
    return s;
}
async function requirePost(db: Db, postId: string, lock = false) { const rows = lock ? await db `select * from app.lock_post(${postId})` : await db `select * from app.posts where id=${postId}`; if (!rows[0])
    fail('NOT_FOUND', 404); return rows[0]; }
async function attachMedia(db: Db, member: string, postId: string, mediaIds: string[]) { if (!mediaIds.length)
    return; const rows = await db `select id,envelope from app.media_assets where id in ${db(mediaIds)} and owner_id=${member} and post_id is null and state='ready' for update`; if (rows.length !== mediaIds.length)
    fail('MEDIA_NOT_READY', 409); const post = await requirePost(db, postId); for (const media of rows) {
    if (media.envelope.context.parentId !== postId || media.envelope.context.audience !== post.audience || media.envelope.context.groupId !== post.group_id || canonicalJson(media.envelope.recipients) !== canonicalJson(post.envelope.recipients))
        fail('MEDIA_AUDIENCE_MISMATCH', 409);
} for (let i = 0; i < mediaIds.length; i++)
    await db `update app.media_assets set post_id=${postId},state='attached',display_order=${i} where id=${mediaIds[i]}`; }
const backupKey = z.object({ public_key: z.string().max(30000), fingerprint: z.string().regex(/^[0-9a-f]{64}$/), encrypted_private_key: z.string().startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----').max(30000) }).strict();
const backupSchema = z.object({ v: z.literal(1), devices: z.array(backupKey.extend({ id: uuid })).min(1).max(32), recovery: backupKey }).strict();
async function checkBackup(value: unknown) { const backup = backupSchema.parse(value); for (const key of [...backup.devices, backup.recovery]) {
    if (await fingerprint(key.public_key) !== key.fingerprint)
        fail('INVALID_KEY');
    await validateEncryptedPrivateKey(key.encrypted_private_key, key.fingerprint);
} return backup; }
export function createSocialRoutes() {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    app.onError((err, c) => {
        if (err instanceof SocialError)
            return c.json({ error: { code: err.code, message: err.code.toLowerCase().replaceAll('_', ' '), ...(err.details ? { details: err.details } : {}) } }, err.status);
        if (err instanceof z.ZodError || err instanceof SyntaxError)
            return c.json({ error: { code: 'INVALID_INPUT', message: 'Check the submitted fields.' } }, 400);
        const code = (err as {
            code?: string;
        }).code;
        const known = ['CONNECTION_LIMIT', 'AUDIENCE_CHANGED', 'TRANSFER_REQUIRED', 'OWNED_GROUPS', 'GROUP_LIMIT', 'EXPIRY_CANNOT_EXTEND', 'CONTENT_DELETED','EXPORT_INVALIDATED','MEDIA_NOT_READY','MEDIA_AUDIENCE_MISMATCH','MEDIA_ATTACHMENT_CHANGED','REVISION_CHANGED','REACTION_LIMIT','REACTION_STORAGE_LIMIT'];
        if (known.includes(err.message))
            return c.json({ error: { code: err.message, message: err.message.toLowerCase().replaceAll('_', ' ') } }, 409);
        if (code === '23505')
            return c.json({ error: { code: 'CONFLICT', message: 'This item already exists.' } }, 409);
        if (code === '42501' || err.message === 'FORBIDDEN')
            return c.json({ error: { code: 'FORBIDDEN', message: 'This action is unavailable.' } }, 403);
        if (err.message === 'NOT_FOUND')
            return c.json({ error: { code: 'NOT_FOUND', message: 'This item is unavailable.' } }, 404);
        // Never log SQL errors: their DETAIL field may contain row values or ciphertext.
        return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Please try again shortly.' } }, 503);
    });
    app.use('*', async (c, next) => { if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
        const allowed = await tx(c, async (db) => { const [r] = await db `select app.allow_social_request() as allowed`; return r.allowed; });
        if (!allowed)
            fail('RATE_LIMIT', 429);
    } c.header('Cache-Control', 'private, no-store'); await next(); });
    registerEmojiRoutes(app,{tx,body,fail,id,writeAllowed,checkEnvelope});
    app.get('/me', async (c) => c.json(await tx(c, async (db) => { const [member] = await db `select m.id,m.status,m.notification_preferences,p.handle,p.envelope from app.members m join app.profiles p on p.member_id=m.id where m.id=${c.get('memberId')}`; const [{ count }] = await db `select count(*)::int count from app.connections`; return { ...member, connection_count: count, connection_limit: 300 }; })));
    app.patch('/me', async (c) => { const b = await body(c, z.object({ notification_preferences: z.object({ in_app: z.boolean(), push: z.boolean() }).strict() })); return c.json(await tx(c, async (db) => { await db `update app.members set notification_preferences=${db.json(b.notification_preferences)} where id=${c.get('memberId')}`; return { ok: true }; })); });
    app.get('/profiles/:handle', async (c) => c.json(await tx(c, async (db) => { const [lookup] = await db `select * from app.lookup_handle(${c.req.param('handle').toLowerCase()})`; if (!lookup)
        fail('NOT_FOUND', 404); const [profile] = await db `select * from app.profiles where member_id=${lookup.id}`; return profile ?? { member_id: lookup.id, handle: lookup.handle, envelope: null }; })));
    app.get('/profiles/member/:id', async (c) => c.json(await tx(c, async (db) => { const [profile] = await db `select * from app.profiles where member_id=${id(c.req.param('id'))}`; if (!profile)
        fail('NOT_FOUND', 404); return profile; })));
    app.put('/profiles/me', async (c) => {
        const b = await body(c, envelopeBody.extend({remove_media: surfaceRemovals(['avatar', 'cover', 'background'], 3)}));
        return c.json(await tx(c, async (db) => {
            await checkEnvelope(db, c.get('memberId'), b.envelope, 'profile', {allowPast: true});
            if (b.envelope.context.id !== c.get('memberId')) fail('ENVELOPE_CONTEXT');
            if (b.remove_media.length) await db`select app.remove_surface_media('profile',${c.get('memberId')},${db.json(b.remove_media)})`;
            const rows = await db`update app.profiles set envelope=${db.json(b.envelope)},updated_at=now() where member_id=${c.get('memberId')} returning member_id`;
            if (!rows.length) fail('FORBIDDEN', 403);
            return {ok: true};
        }));
    });
    app.get('/audiences', async (c) => { return c.json(await tx(c, db => snapshot(db, z.enum(['only_me', 'connections', 'friends', 'family', 'group', 'moderators']).parse(c.req.query('audience') ?? 'connections'), c.req.query('group_id') ? id(c.req.query('group_id')) : null, c.req.query('post_id') ? id(c.req.query('post_id')) : null))); });
    app.get('/devices', async (c) => c.json({ items: await tx(c, db => db `select id,member_id,public_key,fingerprint,created_at,revoked_at from app.device_keys order by created_at`) }));
    app.get('/devices/:id', async (c) => c.json(await tx(c, async (db) => { const [d] = await db `select * from app.author_key(${id(c.req.param('id'))})`; if (!d)
        fail('NOT_FOUND', 404); return d; })));
    const deviceInput = z.object({ id: uuid, public_key: z.string().max(30000), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
    app.post('/devices/challenge', async (c) => { recent(c); const b = await body(c, deviceInput); if (await fingerprint(b.public_key) !== b.fingerprint)
        fail('INVALID_KEY'); const challenge = crypto.randomUUID() + crypto.randomUUID(); const expires = new Date(Date.now() + 10 * 60000).toISOString(); return c.json(await tx(c, async (db) => { await db `insert into app.device_challenges(member_id,device_id,public_key,fingerprint,challenge,expires_at) values(${c.get('memberId')},${b.id},${b.public_key},${b.fingerprint},${challenge},${expires}) on conflict(device_id) do update set challenge=excluded.challenge,expires_at=excluded.expires_at,consumed_at=null where device_challenges.member_id=excluded.member_id and device_challenges.public_key=excluded.public_key`; return { challenge, expires_at: expires }; })); });
    app.post('/devices', async (c) => {
        recent(c);
        const b = await body(c, deviceInput.extend({ authorization: z.object({ type: z.enum(['initial', 'trusted', 'recovery']), signed: z.any().optional() }), recovery_public_key: z.string().max(30000).optional(), backup: backupSchema.optional() }));
        if (await fingerprint(b.public_key) !== b.fingerprint)
            fail('INVALID_KEY');
        return c.json(await tx(c, async (db) => {
            await db `select app.bump_epoch()`;
            const [same] = await db `select id,public_key,fingerprint,revoked_at from app.device_keys where id=${b.id} and member_id=${c.get('memberId')}`;
            if (same) {
                if (same.public_key !== b.public_key || same.fingerprint !== b.fingerprint || same.revoked_at)
                    fail('DEVICE_NOT_TRUSTED', 403);
                return { id: b.id };
            }
            const existing = await db `select id from app.device_keys where member_id=${c.get('memberId')}`;
            if (existing.length === 0) {
                if (b.authorization.type !== 'initial' || !b.recovery_public_key || !b.backup)
                    fail('RECOVERY_SETUP_REQUIRED');
                await fingerprint(b.recovery_public_key);
                await checkBackup(b.backup);
                if (b.backup.recovery.public_key !== b.recovery_public_key || !b.backup.devices.some(d => d.id === b.id && d.public_key === b.public_key))
                    fail('BACKUP_KEY_MISMATCH');
                await db `insert into app.recovery_keys(member_id,public_key) values(${c.get('memberId')},${b.recovery_public_key})`;
                await db `insert into app.encrypted_key_backups(member_id,envelope) values(${c.get('memberId')},${db.json(b.backup)})`;
            }
            else {
                if (b.authorization.type === 'initial')
                    fail('TRUSTED_DEVICE_REQUIRED', 403);
                if (!b.backup) fail('RECOVERY_SETUP_REQUIRED');
                await checkBackup(b.backup);
                const [previous] = await db`select envelope from app.encrypted_key_backups where member_id=${c.get('memberId')} for update`;
                if(!previous || canonicalJson(previous.envelope.recovery)!==canonicalJson(b.backup.recovery)
                    || !b.backup.devices.some(d=>d.id===b.id&&d.public_key===b.public_key&&d.fingerprint===b.fingerprint)
                    || new Set(b.backup.devices.map(d=>d.id)).size!==b.backup.devices.length
                    || b.backup.devices.length!==previous.envelope.devices.length+1
                    || !previous.envelope.devices.every((old:any)=>b.backup!.devices.some(d=>d.id===old.id&&canonicalJson(d)===canonicalJson(old)))) fail('BACKUP_KEY_MISMATCH');
                const [challenge] = await db `select * from app.device_challenges where member_id=${c.get('memberId')} and device_id=${b.id} and consumed_at is null and expires_at>now() for update`;
                if (!challenge || challenge.fingerprint !== b.fingerprint || challenge.public_key !== b.public_key)
                    fail('CHALLENGE_EXPIRED', 403);
                let key: string;
                if (b.authorization.type === 'recovery') {
                    const [r] = await db `select public_key from app.recovery_keys where member_id=${c.get('memberId')}`;
                    if (b.authorization.signed?.statement?.authorizingDeviceId !== 'recovery')
                        fail('INVALID_PROOF', 403);
                    key = r?.public_key;
                }
                else {
                    const authorizer = id(b.authorization.signed?.statement?.authorizingDeviceId);
                    const [r] = await db `select public_key from app.device_keys where id=${authorizer} and member_id=${c.get('memberId')} and revoked_at is null`;
                    key = r?.public_key;
                }
                if (!key)
                    fail('INVALID_PROOF', 403);
                try {
                    await verifyDeviceAuthorization(b.authorization.signed, key, { memberId: c.get('memberId'), deviceId: b.id, fingerprint: b.fingerprint, challenge: challenge.challenge });
                }
                catch {
                    fail('INVALID_PROOF', 403);
                }
                await db `update app.device_challenges set consumed_at=now() where device_id=${b.id}`;
                await db`update app.encrypted_key_backups set envelope=${db.json(b.backup)},updated_at=now() where member_id=${c.get('memberId')}`;
            }
            await db `insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${b.id},${c.get('memberId')},${b.public_key},${b.fingerprint},${db.json(b.authorization)})`;
            return { id: b.id };
        }), 201);
    });
    app.delete('/devices/:id', async (c) => { recent(c); return c.json(await tx(c, async (db) => { await db `select app.bump_epoch()`; await db `update app.device_keys set revoked_at=now() where id=${id(c.req.param('id'))} and member_id=${c.get('memberId')}`; return { ok: true }; })); });
    app.get('/keys/backup', async (c) => { recent(c); return c.json(await tx(c, async (db) => { const [r] = await db `select envelope from app.encrypted_key_backups where member_id=${c.get('memberId')}`; if (!r)
        fail('NOT_FOUND', 404); return r; })); });
    app.put('/keys/backup', async (c) => { recent(c); const b = await body(c, z.object({ envelope: backupSchema })); await checkBackup(b.envelope); return c.json(await tx(c, async (db) => { const [recovery] = await db `select public_key from app.recovery_keys where member_id=${c.get('memberId')}`; if (!recovery || b.envelope.recovery.public_key !== recovery.public_key)
        fail('BACKUP_KEY_MISMATCH'); await db `update app.encrypted_key_backups set envelope=${db.json(b.envelope)},updated_at=now() where member_id=${c.get('memberId')}`; return { ok: true }; })); });
    app.get('/connections', async (c) => c.json(await tx(c, async (db) => { const items = await db `select c.id,c.member_a,c.member_b,c.accepted_at,coalesce(to_jsonb(c)->>(case when c.member_a=app.actor() then 'kind_a' else 'kind_b' end),c.kind) as kind,c.proposed_kind,c.proposed_by,case when c.member_a=app.actor() then c.history_a else c.history_b end as own_history,case when c.member_a=app.actor() then c.history_b else c.history_a end as peer_history from app.connections c order by c.accepted_at desc`; const requests = await db `select id,sender,recipient,state,created_at,history,case when sender=app.actor() then kind else null end as kind from app.connection_requests where state='pending' order by created_at desc`; const ids = [...new Set([...items.flatMap(r => [r.member_a, r.member_b]), ...requests.flatMap(r => [r.sender, r.recipient])])]; const handles = ids.length ? await db `select * from app.member_handles(array(select jsonb_array_elements_text(${db.json(ids)}))::uuid[])` : []; return { items, requests, handles, limit: 300 }; })));
    app.post('/connections/requests', async (c) => { const b = await body(c, z.object({ handle: z.string().regex(/^[a-z0-9_]{3,24}$/), kind: z.enum(['friend', 'family']), history: historyMode.default('future'), id: uuid.optional() })); return c.json(await tx(c, async (db) => { await writeAllowed(db); const [target] = await db `select * from app.lookup_handle(${b.handle})`; if (!target || target.id === c.get('memberId'))
        fail('NOT_FOUND', 404); const [{ count }] = await db `select count(*)::int count from app.connection_requests where sender=${c.get('memberId')} and created_at>now()-interval '1 day'`; if (count >= 30)
        fail('REQUEST_LIMIT', 429); const requestId = b.id ?? crypto.randomUUID(); await db `insert into app.connection_requests(id,sender,recipient,kind,history) values(${requestId},${c.get('memberId')},${target.id},${b.kind},${b.history})`; await db `select app.notify(${target.id},'connection_request',null,null,null,${'request:' + requestId})`; return { id: requestId }; }), 201); });
    app.post('/connections/requests/:id/accept', async (c) => { const b=await body(c,z.object({history:historyMode.default('future')}).strict(),1024,true); return c.json(await tx(c,async db=>{const [r]=await db`select app.accept_connection_with_history(${id(c.req.param('id'))},${b.history}) as id`;return r;})); });
    app.post('/connections/requests/:id/decline', async (c) => c.json(await tx(c, async (db) => { await db `update app.connection_requests set state=case when sender=${c.get('memberId')} then 'cancelled' else 'declined' end where id=${id(c.req.param('id'))} and state='pending'`; return { ok: true }; })));
    app.delete('/connections/:id', async (c) => c.json(await tx(c, async (db) => { await db `select app.change_connection(${id(c.req.param('id'))},null,true)`; return { ok: true }; })));
    app.put('/connections/:id/kind', async (c) => { const b = await body(c, z.object({ kind: z.enum(['friend', 'family']) })); return c.json(await tx(c, async (db) => { await db `select app.change_connection(${id(c.req.param('id'))},${b.kind},false)`; return { ok: true }; })); });
    app.put('/connections/:id/history', async c => {const b=await body(c,z.object({history:historyMode}).strict());return c.json(await tx(c,async db=>{await db`select app.set_connection_history(${id(c.req.param('id'))},${b.history})`;return {ok:true};}));});
    app.get('/blocks', async (c) => c.json({ items: await tx(c, db => db `select target,created_at from app.blocks order by created_at`) }));
    app.put('/blocks/:id', async (c) => c.json(await tx(c, async (db) => { await db `select app.set_block(${id(c.req.param('id'))},true)`; return { ok: true }; })));
    app.delete('/blocks/:id', async (c) => c.json(await tx(c, async (db) => { await db `select app.set_block(${id(c.req.param('id'))},false)`; return { ok: true }; })));
    app.get('/mutes', async (c) => c.json({ items: await tx(c, db => db `select target from app.mutes`) }));
    app.put('/mutes/:id', async (c) => c.json(await tx(c, async (db) => { await db `insert into app.mutes(actor,target) values(${c.get('memberId')},${id(c.req.param('id'))}) on conflict do nothing`; return { ok: true }; })));
    app.delete('/mutes/:id', async (c) => c.json(await tx(c, async (db) => { await db `delete from app.mutes where actor=${c.get('memberId')} and target=${id(c.req.param('id'))}`; return { ok: true }; })));
    app.get('/feed', async (c) => {
        const after = cursor(c.req.query('cursor'));
        return c.json(await tx(c, async (db) => page(await db`
            select p.*,h.handle as author_handle from app.posts p
            left join lateral app.member_handles(array[p.author_id]) h on true
            where p.group_id is null and p.author_id=any(array(
                select app.actor() union all
                select member_b from app.connections where member_a=app.actor() union all
                select member_a from app.connections where member_b=app.actor()
            )) and not exists(select from app.mutes where target=p.author_id)
            ${after ? db`and(p.created_at,p.id)<(${after.at}::timestamptz,${after.id}::uuid)` : db``}
            order by p.created_at desc,p.id desc limit 31
        `)));
    });
    app.get('/walls/:id', async (c) => { const after = cursor(c.req.query('cursor')); return c.json(await tx(c, async (db) => page(await db `select * from app.posts where author_id=${id(c.req.param('id'))} and group_id is null ${after ? db `and(created_at,id)<(${after.at}::timestamptz,${after.id}::uuid)` : db ``} order by created_at desc,id desc limit 31`))); });
    app.post('/posts', async (c) => {
        const b = await body(c, envelopeBody.extend({ media_ids: z.array(uuid).max(10).default([]) }));
        return c.json(await tx(c, async (db) => {
            const e = b.envelope.context;
            id(e.id);
            const [existing] = await db `select id,envelope from app.posts where id=${e.id} and author_id=${c.get('memberId')}`;
            if (existing) {
                if (canonicalJson(existing.envelope) !== canonicalJson(b.envelope))
                    fail('CONFLICT', 409);
                return { id: e.id };
            }
            if (e.parentId !== null)
                fail('ENVELOPE_CONTEXT');
            await checkEnvelope(db, c.get('memberId'), b.envelope, 'post');
            await db `insert into app.posts(id,author_id,group_id,audience,envelope,epoch,created_at,expires_at) values(${e.id},${c.get('memberId')},${e.groupId},${e.audience},${db.json(b.envelope)},${e.epoch},${e.createdAt},${e.expiresAt})`;
            for (const r of b.envelope.recipients)
                await db `insert into app.post_recipients(post_id,device_id,member_id) values(${e.id},${r.deviceId},${r.memberId})`;
            await attachMedia(db, c.get('memberId'), e.id, b.media_ids);
            return { id: e.id };
        }), 201);
    });
    // Only author-encrypted revisions may add historical access. The server
    // supplies the consent-filtered directory; it never decrypts member content.
    app.get('/posts/audience-refresh', async c => {
        const after=cursor(c.req.query('cursor'));
        return c.json(await tx(c,async db=>{
            await db`select app.lock_epoch()`;
            const rows=await db`select p.* from app.posts p where p.author_id=app.actor()
                and p.group_id is null and p.audience in('connections','friends','family')
                ${after?db`and(p.created_at,p.id)<(${after.at}::timestamptz,${after.id}::uuid)`:db``}
                and exists(select from app.history_audience_devices(p.id) d where
                    not exists(select from app.post_recipients r where r.post_id=p.id and r.device_id=d.id and r.member_id=d.member_id)
                    or not exists(select from jsonb_array_elements(p.envelope->'recipients') r where r->>'deviceId'=d.id::text and r->>'memberId'=d.member_id::text and r->>'fingerprint'=d.fingerprint))
                order by p.created_at desc,p.id desc limit 11`;
            return page(rows,10);
        }));
    });
    app.get('/posts/:id/audience-refresh/audience',async c=>c.json(await tx(c,async db=>{
        const source=await requirePost(db,id(c.req.param('id')),true);
        if(source.author_id!==c.get('memberId'))fail('FORBIDDEN',403);
        return snapshot(db,source.audience,source.group_id,null,source.id);
    })));
    app.post('/posts/:id/audience-refresh',async c=>{
        const b=await body(c,envelopeBody.extend({lifecycle:z.any(),source_revision:z.number().int().positive(),source_expires_at:date.nullable(),source_media_ids:mediaIds,media_ids:mediaIds}).strict());
        return c.json(await tx(c,async db=>{
            await writeAllowed(db);
            const source=await requirePost(db,id(c.req.param('id')),true),e=b.envelope.context,old=source.envelope.context;
            if(source.author_id!==c.get('memberId'))fail('FORBIDDEN',403);
            if(source.group_id!==null||!['connections','friends','family'].includes(source.audience)
                ||e.id!==source.id||e.authorId!==old.authorId||e.createdAt!==old.createdAt
                ||e.audience!==old.audience||e.groupId!==old.groupId||e.parentId!==old.parentId
                ||e.revision!==b.source_revision+1)fail('ENVELOPE_CONTEXT');
            const retry=canonicalJson(source.envelope)===canonicalJson(b.envelope);
            if(!retry&&old.revision!==b.source_revision)fail('REVISION_CHANGED',409);
            if(!retry&&iso(source.expires_at)!==iso(b.source_expires_at))fail('PARENT_DEADLINE_CHANGED',409,{expires_at:iso(source.expires_at)});
            if(b.source_expires_at&&(!e.expiresAt||Date.parse(e.expiresAt)>Date.parse(b.source_expires_at)))fail('EXPIRY_CANNOT_EXTEND',409);
            const [key]=await db`select public_key from app.device_keys where id=${e.authorDeviceId} and member_id=${c.get('memberId')} and revoked_at is null`;
            if(!key)fail('DEVICE_NOT_TRUSTED',403);
            try {const proof=await verifyStatement(b.lifecycle,key.public_key);if(canonicalJson(proof)!==canonicalJson({purpose:'porchday-lifecycle',id:e.id,revision:e.revision,expiresAt:e.expiresAt}))fail('INVALID_PROOF',403);}catch{fail('INVALID_PROOF',403);}
            await checkEnvelope(db,c.get('memberId'),b.envelope,'post',{allowPast:true,historyPostId:source.id,skipEpoch:retry});
            const attached=await db`select id,envelope from app.media_assets where post_id=${source.id} order by display_order for update`;
            if(retry){if(canonicalJson(attached.map(r=>r.id))!==canonicalJson(b.media_ids))fail('MEDIA_ATTACHMENT_CHANGED',409);return {id:source.id,ok:true};}
            if(canonicalJson(attached.map(r=>r.id).sort())!==canonicalJson([...b.source_media_ids].sort())||b.source_media_ids.length!==b.media_ids.length||b.media_ids.some(id=>b.source_media_ids.includes(id)))fail('MEDIA_ATTACHMENT_CHANGED',409);
            if(b.media_ids.length){
                const replacements=await db`select id,envelope from app.media_assets where id in ${db(b.media_ids)} and owner_id=${c.get('memberId')} and post_id is null and state='ready' for update`;
                if(replacements.length!==b.media_ids.length)fail('MEDIA_NOT_READY',409);
                for(let i=0;i<b.source_media_ids.length;i++){
                    const deadline=attached.find(row=>row.id===b.source_media_ids[i])!.envelope.context.expiresAt;
                    const next=replacements.find(row=>row.id===b.media_ids[i])!.envelope.context.expiresAt;
                    if(deadline&&(!next||Date.parse(next)>Date.parse(deadline)))fail('EXPIRY_CANNOT_EXTEND',409);
                }
            }
            await db`update app.posts set envelope=${db.json(b.envelope)},epoch=${e.epoch},expires_at=${e.expiresAt} where id=${source.id}`;
            for(const recipient of b.envelope.recipients)await db`insert into app.post_recipients(post_id,device_id,member_id) values(${source.id},${recipient.deviceId},${recipient.memberId}) on conflict do nothing`;
            await attachMedia(db,c.get('memberId'),source.id,b.media_ids);
            if(b.source_media_ids.length)await db`delete from app.media_assets where post_id=${source.id} and id in ${db(b.source_media_ids)}`;
            return {id:source.id,ok:true};
        }));
    });
    app.post('/posts/:id/reshare', async c => {
        const b = await body(c, envelopeBody.extend({source_expires_at:date.nullable(),media_ids:z.array(uuid).max(20).default([])}));
        return c.json(await tx(c, async db => {
            await writeAllowed(db);
            const source = await requirePost(db,id(c.req.param('id')),true);
            if(source.author_id!==c.get('memberId')) fail('FORBIDDEN',403);
            if(iso(source.expires_at)!==iso(b.source_expires_at)) fail('PARENT_DEADLINE_CHANGED',409,{expires_at:iso(source.expires_at)});
            const e=b.envelope.context;id(e.id);
            if(e.id===source.id||e.parentId!==null) fail('ENVELOPE_CONTEXT');
            if(source.expires_at&&(!e.expiresAt||Date.parse(e.expiresAt)>new Date(source.expires_at).getTime())) fail('EXPIRY_CANNOT_EXTEND',409);
            await checkEnvelope(db,c.get('memberId'),b.envelope,'post');
            const [existing]=await db`select id,envelope from app.posts where id=${e.id} and author_id=${c.get('memberId')}`;
            if(existing){if(canonicalJson(existing.envelope)!==canonicalJson(b.envelope))fail('CONFLICT',409);return {id:e.id};}
            await db`insert into app.posts(id,author_id,group_id,audience,envelope,epoch,created_at,expires_at) values(${e.id},${c.get('memberId')},${e.groupId},${e.audience},${db.json(b.envelope)},${e.epoch},${e.createdAt},${e.expiresAt})`;
            for(const r of b.envelope.recipients)await db`insert into app.post_recipients(post_id,device_id,member_id) values(${e.id},${r.deviceId},${r.memberId})`;
            await attachMedia(db,c.get('memberId'),e.id,b.media_ids);
            return {id:e.id};
        }),201);
    });
    app.get('/posts/:id', async (c) => c.json(await tx(c, async (db) => { const post = await requirePost(db, id(c.req.param('id'))); const comments = await db `select c.*,h.handle as author_handle,app.comment_deadline(c.id) as effective_expires_at from app.comments c left join lateral app.member_handles(array[c.author_id]) h on true where post_id=${post.id} order by created_at,id`; const reactions = await db `select * from app.post_reactions where post_id=${post.id}`; const comment_reactions = await db `select r.* from app.comment_reactions r join app.comments c on c.id=r.comment_id where c.post_id=${post.id}`; const media = await db `select id,envelope,byte_size,display_order from app.media_assets where post_id=${post.id} order by display_order`; // Newly admitted readers are not recipients of other authors' older
        // signed children. Never send undecryptable replies or orphan threads.
        const addressed=(row:any)=>row.envelope.recipients.some((r:any)=>r.memberId===c.get('memberId'));
        const visible=new Set<string>();let added=true;
        while(added){added=false;for(const comment of comments)if(!visible.has(comment.id)&&addressed(comment)&&(!comment.parent_id||visible.has(comment.parent_id))){visible.add(comment.id);added=true;}}
        return { post: { ...post, media }, comments:comments.filter(row=>visible.has(row.id)), reactions:reactions.filter(addressed), comment_reactions:comment_reactions.filter(row=>visible.has(row.comment_id)&&addressed(row)) }; })));
    app.delete('/posts/:id', async (c) => c.json(await tx(c, async (db) => { const rows = await db `delete from app.posts where id=${id(c.req.param('id'))} returning id`; if (!rows.length)
        fail('NOT_FOUND', 404); return { ok: true }; })));
    app.post('/posts/:id/comments', async (c) => {
        const b = await body(c, envelopeBody.extend({ parent_expires_at: date.nullable() }));
        return c.json(await tx(c, async (db) => {
            const post = await requirePost(db, id(c.req.param('id')), true);
            const e = b.envelope.context;
            id(e.id);
            if (e.audience !== post.audience || e.groupId !== post.group_id)
                fail('ENVELOPE_CONTEXT');
            let parentId: string | null = e.parentId === post.id ? null : e.parentId;
            if (!e.parentId)
                fail('PARENT_REQUIRED');
            let deadline = iso(post.expires_at);
            if (parentId) {
                const [parent] = await db `select *,app.comment_deadline(id) as effective_expires_at from app.lock_comment(${parentId}) where post_id=${post.id}`;
                if (!parent)
                    fail('NOT_FOUND', 404);
                deadline = iso(parent.effective_expires_at);
            }
            if (iso(b.parent_expires_at) !== deadline)
                fail('PARENT_DEADLINE_CHANGED', 409, { expires_at: deadline });
            if (deadline && (!e.expiresAt || Date.parse(e.expiresAt) > Date.parse(deadline)))
                fail('INHERITED_DEADLINE');
            await checkEnvelope(db, c.get('memberId'), b.envelope, 'comment', { postId: post.id });
            await db `insert into app.comments(id,post_id,parent_id,author_id,envelope,created_at,expires_at) values(${e.id},${post.id},${parentId},${c.get('memberId')},${db.json(b.envelope)},${e.createdAt},${e.expiresAt})`;
            await db `select app.notify(${post.author_id},'comment',${post.id},${e.id},null,${'comment:' + e.id})`;
            return { id: e.id, effective_expires_at: e.expiresAt };
        }), 201);
    });
    app.delete('/comments/:id', async (c) => c.json(await tx(c, async (db) => { const rows = await db `delete from app.comments where id=${id(c.req.param('id'))} returning id`; if (!rows.length)
        fail('NOT_FOUND', 404); return { ok: true }; })));
    for (const kind of ['posts', 'comments'] as const) {
        app.put(`/${kind}/:id`, async (c) => {
            const b = await body(c, envelopeBody.extend({ lifecycle: z.any() }));
            return c.json(await tx(c, async (db) => {
                const targetId = id(c.req.param('id'));
                let row: any;
                if (kind === 'posts')
                    row = await requirePost(db, targetId, true);
                else {
                    const [found] = await db `select * from app.comments where id=${targetId}`;
                    if (!found)
                        fail('NOT_FOUND', 404);
                    await requirePost(db, found.post_id, true);
                    [row] = await db `select * from app.comments where id=${targetId} for update`;
                }
                if (row.author_id !== c.get('memberId'))
                    fail('FORBIDDEN', 403);
                const e = b.envelope.context;
                const old = row.envelope.context;
                if (e.id !== row.id || e.authorId !== old.authorId || e.createdAt !== old.createdAt || e.audience !== old.audience || e.groupId !== old.groupId || e.parentId !== old.parentId || e.revision !== old.revision + 1)
                    fail('ENVELOPE_CONTEXT');
                if (row.expires_at && (!e.expiresAt || Date.parse(e.expiresAt) > new Date(row.expires_at).getTime()))
                    fail('EXPIRY_CANNOT_EXTEND', 409);
                const [key] = await db `select public_key from app.device_keys where id=${e.authorDeviceId} and revoked_at is null`;
                if (!key)
                    fail('DEVICE_NOT_TRUSTED', 403);
                const expected = { purpose: 'porchday-lifecycle', id: e.id, revision: e.revision, expiresAt: e.expiresAt };
                try {
                    const statement = await verifyStatement(b.lifecycle, key.public_key);
                    if (canonicalJson(statement) !== canonicalJson(expected))
                        fail('INVALID_PROOF', 403);
                }
                catch {
                    fail('INVALID_PROOF', 403);
                }
                await checkEnvelope(db, c.get('memberId'), b.envelope, kind === 'posts' ? 'post' : 'comment', { postId: kind === 'posts' ? row.id : row.post_id, allowPast: true });
                if (kind === 'posts')
                    await db `update app.posts set envelope=${db.json(b.envelope)},expires_at=${e.expiresAt},edited_at=now() where id=${row.id}`;
                else
                    await db `update app.comments set envelope=${db.json(b.envelope)},expires_at=${e.expiresAt},edited_at=now() where id=${row.id}`;
                return { ok: true };
            }));
        });
        app.put(`/${kind}/:id/reactions/:tag`, async (c) => { const b = await body(c, envelopeBody); const targetId = id(c.req.param('id')); const tag = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).parse(c.req.param('tag')); return c.json(await tx(c, async (db) => { let postId = targetId; if (kind === 'comments') {
            const [comment] = await db `select post_id from app.comments where id=${targetId}`;
            if (!comment)
                fail('NOT_FOUND', 404);
            postId = comment.post_id;
        } const post = await requirePost(db, postId, true); const e = b.envelope.context; let inherited = iso(post.expires_at); if (kind === 'comments') {
            const [r] = await db `select app.comment_deadline(${targetId}) as expires_at`;
            inherited = iso(r.expires_at);
        } if (inherited && (!e.expiresAt || Date.parse(e.expiresAt) > Date.parse(inherited)))
            fail('INHERITED_DEADLINE'); if (e.parentId !== targetId || e.id !== tag || e.audience !== post.audience || e.groupId !== post.group_id)
            fail('ENVELOPE_CONTEXT'); await checkEnvelope(db, c.get('memberId'), b.envelope, 'reaction', { postId }); if (kind === 'posts')
            await db `insert into app.post_reactions(post_id,member_id,reaction_tag,envelope) values(${targetId},${c.get('memberId')},${tag},${db.json(b.envelope)}) on conflict(post_id,member_id,reaction_tag) do nothing`;
        else
            await db `insert into app.comment_reactions(comment_id,member_id,reaction_tag,envelope) values(${targetId},${c.get('memberId')},${tag},${db.json(b.envelope)}) on conflict(comment_id,member_id,reaction_tag) do nothing`; return { ok: true }; })); });
        app.delete(`/${kind}/:id/reactions/:tag`, async (c) => c.json(await tx(c, async (db) => { const targetId = id(c.req.param('id')); const tag = c.req.param('tag'); if (kind === 'posts')
            await db `delete from app.post_reactions where post_id=${targetId} and member_id=${c.get('memberId')} and reaction_tag=${tag}`;
        else
            await db `delete from app.comment_reactions where comment_id=${targetId} and member_id=${c.get('memberId')} and reaction_tag=${tag}`; return { ok: true }; })));
    }
    app.get('/groups', async (c) => c.json(await tx(c, async (db) => ({ items: await db `select g.*,m.role from app.groups g join app.group_memberships m on m.group_id=g.id and m.member_id=${c.get('memberId')} order by g.created_at desc`, invitations: await db `select * from app.group_invitations where recipient=${c.get('memberId')} and accepted_at is null and expires_at>now()` }))));
    app.post('/groups', async (c) => { const b = await body(c, envelopeBody); return c.json(await tx(c, async (db) => { const e = b.envelope.context; id(e.id); if (e.audience !== 'only_me' || e.groupId !== null)
        fail('INITIAL_GROUP_AUDIENCE'); await checkEnvelope(db, c.get('memberId'), b.envelope, 'group'); await db `select app.create_group(${e.id},${db.json(b.envelope)})`; return { id: e.id }; }), 201); });
    app.get('/groups/:id', async (c) => c.json(await tx(c, async (db) => { const groupId = id(c.req.param('id')); const [group] = await db `select * from app.groups where id=${groupId}`; if (!group)
        fail('NOT_FOUND', 404); const members = await db `select * from app.group_memberships where group_id=${groupId}`; const handles = await db `select * from app.member_handles(array(select jsonb_array_elements_text(${db.json(members.map(m => m.member_id))}))::uuid[])`; return { group, members, handles }; })));
    app.get('/groups/:id/posts', async (c) => { const after = cursor(c.req.query('cursor')); return c.json(await tx(c, async (db) => page(await db `select * from app.posts where group_id=${id(c.req.param('id'))} ${after ? db `and(created_at,id)<(${after.at}::timestamptz,${after.id}::uuid)` : db ``} order by created_at desc,id desc limit 31`))); });
    app.put('/groups/:id', async (c) => {
        const b = await body(c, envelopeBody.extend({remove_media: surfaceRemovals(['image'], 1)}));
        return c.json(await tx(c, async (db) => {
            const groupId = id(c.req.param('id'));
            if (b.envelope.context.id !== groupId) fail('ENVELOPE_CONTEXT');
            await checkEnvelope(db, c.get('memberId'), b.envelope, 'group', {allowPast: true});
            if (b.remove_media.length) await db`select app.remove_surface_media('group',${groupId},${db.json(b.remove_media)})`;
            const rows = await db`update app.groups set envelope=${db.json(b.envelope)} where id=${groupId} returning id`;
            if (!rows.length) fail('FORBIDDEN', 403);
            return {ok: true};
        }));
    });
    app.post('/groups/:id/invitations', async (c) => { const b = await body(c, z.object({ handle: z.string().regex(/^[a-z0-9_]{3,24}$/), envelope: envelopeSchema.optional() })); return c.json(await tx(c, async (db) => { const [recipient] = await db `select * from app.lookup_handle(${b.handle})`; if (!recipient)
        fail('NOT_FOUND', 404); const inviteId = crypto.randomUUID(); await db `insert into app.group_invitations(id,group_id,inviter,recipient,envelope) values(${inviteId},${id(c.req.param('id'))},${c.get('memberId')},${recipient.id},${b.envelope ? db.json(b.envelope) : null}) on conflict(group_id,recipient) do update set id=excluded.id,expires_at=now()+interval '7 days',accepted_at=null`; return { id: inviteId }; }), 201); });
    app.post('/group-invitations/:id/accept', async (c) => c.json(await tx(c, async (db) => { const [r] = await db `select app.accept_group_invitation(${id(c.req.param('id'))}) as id`; return r; })));
    app.put('/groups/:id/members/:memberId', async (c) => { const b = await body(c, z.object({ role: z.enum(['owner', 'moderator', 'member']) })); return c.json(await tx(c, async (db) => { await db `select app.change_group_member(${id(c.req.param('id'))},${id(c.req.param('memberId'))},${b.role})`; return { ok: true }; })); });
    app.delete('/groups/:id/members/:memberId', async (c) => c.json(await tx(c, async (db) => { await db `select app.change_group_member(${id(c.req.param('id'))},${id(c.req.param('memberId'))},'remove')`; return { ok: true }; })));
    app.get('/owned-groups',async c=>c.json({items:await tx(c,db=>db`select * from app.owned_groups_for_deletion()`)}));
    app.delete('/groups/:id', async (c) => c.json(await tx(c, async (db) => { await db `select app.delete_owned_group(${id(c.req.param('id'))})`; return { ok: true }; })));
    app.get('/notifications', async (c) => c.json({ items: await tx(c, db => db `select * from app.notifications order by created_at desc limit 100`) }));
    app.put('/notifications/:id/read', async (c) => c.json(await tx(c, async (db) => { await db `update app.notifications set read_at=now() where id=${id(c.req.param('id'))}`; return { ok: true }; })));
    registerPushRoutes(app, {tx, body, fail, id});
    registerNativePushRoutes(app, {tx, body, fail, id});
    registerMediaRoutes(app, { tx, body, checkEnvelope, writeAllowed, fail, id });
    app.get('/reports', async (c) => c.json({ items: await tx(c, db => db `select id,target_id,reason,status,created_at from app.reports order by created_at desc`) }));
    app.post('/reports', async (c) => { const b = await body(c, z.object({ id: uuid.optional(), target_member: uuid.nullable().default(null), target_id: uuid.nullable().default(null), reason: z.enum(['harassment', 'impersonation', 'spam', 'agent', 'safety', 'other', 'appeal']), evidence_envelope: envelopeSchema.nullable().default(null), evidence_disclosed: z.boolean().default(false) })); if (b.evidence_envelope && !b.evidence_disclosed)
        fail('DISCLOSURE_REQUIRED'); return c.json(await tx(c, async (db) => { const reportId = b.id ?? crypto.randomUUID(); if (b.evidence_envelope) {
        await checkEnvelope(db, c.get('memberId'), b.evidence_envelope, 'report');
        if (b.evidence_envelope.context.parentId !== b.target_id)
            fail('ENVELOPE_CONTEXT');
    } await db `insert into app.reports(id,reporter,target_member,target_id,reason,evidence_envelope,evidence_disclosed) values(${reportId},${c.get('memberId')},${b.target_member},${b.target_id},${b.reason},${b.evidence_envelope ? db.json(b.evidence_envelope) : null},${b.evidence_disclosed})`; return { id: reportId }; }), 201); });
    registerExportRoutes(app, { tx, recent, fail, id });
    app.post('/imports', async (c) => { recent(c); const b = await body(c, z.object({ id: uuid, profile: envelopeBody.optional(), posts: z.array(envelopeBody.extend({ source_id: z.string().max(200), media_ids: z.array(uuid).max(10).default([]) })).max(50) })); return c.json(await tx(c, async (db) => { await writeAllowed(db); if (b.profile) {
        await checkEnvelope(db, c.get('memberId'), b.profile.envelope, 'profile', { allowPast: true });
        if (b.profile.envelope.context.id !== c.get('memberId'))
            fail('ENVELOPE_CONTEXT');
        await db `update app.profiles set envelope=${db.json(b.profile.envelope)},updated_at=now() where member_id=${c.get('memberId')}`;
    } const imported: string[] = []; for (const item of b.posts) {
        const e = item.envelope.context;
        id(e.id);
        if (e.audience !== 'only_me' || e.groupId !== null || e.parentId !== null)
            fail('IMPORT_MUST_BE_PRIVATE');
        await checkEnvelope(db, c.get('memberId'), item.envelope, 'post', { allowPast: true });
        // RETURNING and the partial conflict target apply the SELECT policy,
        // whose STABLE lookup cannot see this command's new row. Preserve that
        // policy and check a zero-count conflict in a subsequent statement.
        const inserted = await db `insert into app.posts(id,author_id,audience,envelope,epoch,created_at,expires_at,import_source) values(${e.id},${c.get('memberId')},'only_me',${db.json(item.envelope)},${e.epoch},${e.createdAt},${e.expiresAt},${item.source_id}) on conflict do nothing`;
        if (inserted.count === 1) {
            await attachMedia(db, c.get('memberId'), e.id, item.media_ids);
            for (const r of item.envelope.recipients)
                await db `insert into app.post_recipients(post_id,device_id,member_id) values(${e.id},${r.deviceId},${r.memberId})`;
            imported.push(e.id);
        } else {
            const [duplicate] = await db `select id from app.posts where author_id=${c.get('memberId')} and import_source=${item.source_id}`;
            if (!duplicate)
                fail('CONFLICT', 409);
        }
    } await db `insert into app.data_transfer_jobs(id,member_id,kind,state) values(${b.id},${c.get('memberId')},'import','complete') on conflict(id) do nothing`; return { id: b.id, imported }; }), 201); });
    return app;
}
