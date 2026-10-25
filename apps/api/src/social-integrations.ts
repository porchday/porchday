import { Hono, type Context } from 'hono';
import { z } from 'zod';
import postgres from 'postgres';
import type { Env, Variables } from './types.js';
import { withMember } from './db.js';
const scopes = z.array(z.enum(['profile:read', 'content:read', 'media:read', 'export:read'])).min(1).max(4);
function randomToken() { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function hash(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join(''); }
async function challenge(s: string) { return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function limited(sql:postgres.Sql,c:Context<{Bindings:Env;Variables:Variables}>,tokenHash:string,kind:'read'|'authorization_code'|'refresh_token',client:string|null=null){
    const [row]=await sql`select app.integration_request_limit(${tokenHash},${kind},${client}::uuid) as retry_after`;
    if(row.retry_after<0)throw Error('Invalid grant');
    if(row.retry_after>0){c.header('Retry-After',String(row.retry_after));return c.json({error:{code:'RATE_LIMIT',message:'Wait before making another integration request.'}},429);}
    return null;
}
const safeRedirect = (uri: string) => { const u = new URL(uri); if (u.username || u.password || u.hash)
    throw Error('Invalid redirect'); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port))
    throw Error('Invalid redirect'); return uri; };
export function createIntegrationConsentRoutes() {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    app.onError((_, c) => { return c.json({ error: { code: 'INVALID_INTEGRATION_REQUEST', message: 'Check this integration request and try again.' } }, 400); });
    app.get('/integrations', async (c) => c.json(await withMember(c.env, c.get('memberId'), async (db) => ({ clients: await db `select id,name,purpose,redirect_uri from app.integration_clients order by created_at`, grants: await db `select g.id,g.client_id,c.name,c.purpose,to_jsonb(g.scopes) as scopes,g.expires_at,g.revoked_at,g.last_used_at from app.integration_grants g join lateral app.integration_client(g.client_id) c on true order by g.created_at desc` }))));
    app.get('/integrations/clients/:id', async (c) => { const id = z.string().uuid().parse(c.req.param('id')); const result = await withMember(c.env, c.get('memberId'), async (db) => { const [client] = await db `select * from app.integration_client(${id})`; if (!client)
        throw Error('Unknown integration'); return client; }); return c.json(result); });
    app.post('/integrations/clients', async (c) => { const b = z.object({ name: z.string().min(1).max(100), purpose: z.string().min(1).max(500), redirect_uri: z.string().url() }).parse(await c.req.json()); safeRedirect(b.redirect_uri); const id = crypto.randomUUID(); await withMember(c.env, c.get('memberId'), db => db `insert into app.integration_clients(id,member_id,name,purpose,redirect_uri) values(${id},${c.get('memberId')},${b.name},${b.purpose},${b.redirect_uri})`); return c.json({ id }, 201); });
    app.post('/integrations/authorize', async (c) => { if (Date.now() - c.get('authTime') > 900000)
        return c.json({ error: { code: 'RECENT_AUTH_REQUIRED', message: 'Sign in again before granting access.' } }, 403); const b = z.object({ client_id: z.string().uuid(), redirect_uri: z.string().url(), scope: scopes, code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), state: z.string().min(16).max(512), consent: z.literal(true) }).parse(await c.req.json()); const code = randomToken(), codeHash = await hash(code), id = crypto.randomUUID(); const redirect = await withMember(c.env, c.get('memberId'), async (db) => { const [client] = await db `select * from app.integration_client(${b.client_id}) where redirect_uri=${b.redirect_uri}`; if (!client)
        throw Error('Unknown integration'); await db `insert into app.integration_grants(id,member_id,client_id,scopes,code_hash,code_challenge,code_expires_at,expires_at) values(${id},${c.get('memberId')},${b.client_id},array(select jsonb_array_elements_text(${db.json(b.scope)})),${codeHash},${b.code_challenge},now()+interval '5 minutes',now()+interval '30 days')`; const url = new URL(client.redirect_uri); url.searchParams.set('code', code); url.searchParams.set('state', b.state); return url.href; }); return c.json({ redirect_uri: redirect, grant_id: id }); });
    app.delete('/integrations/:id', async (c) => { const id = z.string().uuid().parse(c.req.param('id')); await withMember(c.env, c.get('memberId'), db => db `update app.integration_grants set revoked_at=now(),access_hash=null,refresh_hash=null,code_hash=null where id=${id}`); return c.json({ ok: true }); });
    return app;
}
/** Mounted outside cookie authentication; bearer grants never authenticate social routes. */
export function createIntegrationTokenRoutes() {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    app.onError((_, c) => c.json({ error: { code: 'INVALID_GRANT', message: 'This integration grant is unavailable.' } }, 401));
    app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
    app.post('/token', async (c) => { const b = z.object({ grant_type: z.enum(['authorization_code', 'refresh_token']), client_id: z.string().uuid(), redirect_uri: z.string().url().optional(), code: z.string().max(200).optional(), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(), refresh_token: z.string().max(200).optional() }).parse(c.req.header('content-type')?.includes('application/json')?await c.req.json():await c.req.parseBody()); const access = randomToken(), refresh = randomToken(); const sql = postgres(c.env.HYPERDRIVE_SOCIAL.connectionString, { max: 1, prepare: true, fetch_types: false }); try {
        let rows;
        if (b.grant_type === 'authorization_code') {
            if (!b.code || !b.code_verifier || !b.redirect_uri)
                throw Error('Invalid request');
            const codeHash=await hash(b.code),rate=await limited(sql,c,codeHash,'authorization_code',b.client_id);if(rate)return rate;
            rows = await sql `select app.exchange_integration_code(${b.client_id},${b.redirect_uri},${codeHash},${await challenge(b.code_verifier)},${await hash(access)},${await hash(refresh)}) as result`;
        }
        else {
            if (!b.refresh_token)
                throw Error('Invalid request');
            const refreshHash=await hash(b.refresh_token),rate=await limited(sql,c,refreshHash,'refresh_token',b.client_id);if(rate)return rate;
            rows = await sql `select app.refresh_integration(${b.client_id},${refreshHash},${await hash(access)},${await hash(refresh)}) as result`;
        }
        return c.json({ token_type: 'Bearer', access_token: access, refresh_token: refresh, ...rows[0].result });
    }
    finally {
        await sql.end({ timeout: 1 });
    } });
    app.get('/own/:resource', async (c) => { const map: Record<string, string> = { profile: 'profile:read', content: 'content:read', media: 'media:read', exports: 'export:read' }; const scope = map[c.req.param('resource')]; const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]; if (!scope || !token)
        throw Error('Invalid grant'); const sql = postgres(c.env.HYPERDRIVE_SOCIAL.connectionString, { max: 1, prepare: true, fetch_types: false }); try {
        const tokenHash=await hash(token),rate=await limited(sql,c,tokenHash,'read');if(rate)return rate;
        let afterId='';let snapshotAt=new Date().toISOString();
        if(c.req.query('cursor')){const cursor=z.object({id:z.string().max(256),at:z.string().datetime({offset:true})}).parse(JSON.parse(atob(c.req.query('cursor')!)));afterId=cursor.id;snapshotAt=cursor.at;}
        const section=scope==='content:read'?z.enum(['posts','comments','post_reactions','comment_reactions']).parse(c.req.query('section')??'posts'):scope==='profile:read'?'profile':scope==='media:read'?'media':'jobs';
        const [r]=await sql`select app.integration_page(${tokenHash},${scope},${section},${afterId},${snapshotAt}::timestamptz) as data`;
        const {next_id,snapshot_at,...data}=r.data;return c.json({...data,next_cursor:next_id?btoa(JSON.stringify({id:next_id,at:new Date(snapshot_at).toISOString()})):null,snapshot_at,...(scope==='content:read'?{sections:['posts','comments','post_reactions','comment_reactions']}:{})});
    }
    finally {
        await sql.end({ timeout: 1 });
    } });
    app.get('/own/media/:id/bytes', async (c) => { const id = z.string().uuid().parse(c.req.param('id')); const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]; if (!token)
        throw Error('Invalid grant'); const sql = postgres(c.env.HYPERDRIVE_SOCIAL.connectionString, { max: 1, prepare: true, fetch_types: false }); let path: string; try {
        const tokenHash=await hash(token),rate=await limited(sql,c,tokenHash,'read');if(rate)return rate;
        const [r] = await sql `select app.integration_media(${tokenHash},${id}) as path`;
        path = r.path;
    }
    finally {
        await sql.end({ timeout: 1 });
    } const object = await c.env.MEDIA.get(path); if (!object)
        throw Error('Unavailable'); return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } }); });
    app.all('*', c => c.json({ error: { code: 'NOT_FOUND', message: 'No integration operation exists here.' } }, 404));
    return app;
}
