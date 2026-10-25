import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {arch, cpus, totalmem} from 'node:os';
import postgres, {type Sql} from 'postgres';
import {Hono} from 'hono';
import {createSocialRoutes} from '../apps/api/src/social.js';
import type {Env, Variables} from '../apps/api/src/types.js';

/** SQL-path benchmark, not encryption validation, hosted capacity, or an HTTP load test.
 * Uses a new disposable database and restricted login; never alters an existing DB.
 * Ciphertext-shaped high-entropy fixture bytes are deliberately NOT valid OpenPGP.
 */
if (process.argv[2] !== '--run') throw Error('USE_NPX_TSX_SCRIPTS_BENCHMARK_FEED_TS_RUN');
const adminUrl = process.env.LOCAL_BENCHMARK_ADMIN_URL ?? 'postgres://postgres:porchday-local@127.0.0.1:54329/postgres';
const parsed = new URL(adminUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/postgres' || parsed.port !== '54329') throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = 'porchday_feed_benchmark_' + suffix, role = 'porchday_feed_' + suffix;
const password = randomBytes(24).toString('hex');
const admin = postgres(adminUrl, {max: 1, prepare: false, onnotice: () => {}});
let owner: Sql | undefined, runtime: Sql | undefined, databaseCreated = false, roleCreated = false, phase = 'CREATE';
const registered = 10_000, active = 1_000, neighbors = 150, samples = 30, warmups = 5;
const member = (i: number) => `10000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
const device = (i: number) => `20000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
const post = (i: number) => `30000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
const memberSql = (i: string) => `('10000000-0000-4000-8000-'||lpad((${i})::text,12,'0'))::uuid`;
const deviceSql = (i: string) => `('20000000-0000-4000-8000-'||lpad((${i})::text,12,'0'))::uuid`;
const postSql = (i: string) => `('30000000-0000-4000-8000-'||lpad((${i})::text,12,'0'))::uuid`;
const baseQuery = `select p.*,h.handle as author_handle from app.posts p
 left join lateral app.member_handles(array[p.author_id]) h on true
 where group_id is null and not exists(select from app.mutes where target=p.author_id)
 order by p.created_at desc,p.id desc limit 31`;
const candidateQuery = `select p.*,h.handle as author_handle from app.posts p
 left join lateral app.member_handles(array[p.author_id]) h on true
 where group_id is null and p.author_id=any(array(
   select app.actor() union all
   select member_b from app.connections where member_a=app.actor() union all
   select member_a from app.connections where member_b=app.actor()
 )) and not exists(select from app.mutes where target=p.author_id)
 order by p.created_at desc,p.id desc limit 31`;
const report: Record<string, unknown> = {
 scope: 'Local PostgreSQL query path with real restricted-role RLS, warm cache; not HTTP, client crypto, Cloudflare, or hosted capacity',
 generated_at: new Date().toISOString(), host_memory_bytes: totalmem(), host_arch: arch(), host_cpu: cpus()[0]?.model, node_version: process.version,
 fixture: {registered, active, friends_per_active_member: neighbors * 2, posts_per_member: 1, active_ciphertext_bytes: 100 * 1024, inactive_ciphertext_bytes: 1024, synthetic_invalid_openpgp: true},
 results: [],
};
const emit = (value: unknown) => console.log(JSON.stringify(value));
function percentile(values: number[], fraction: number) {const sorted = values.toSorted((a, b) => a - b); return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]?.toFixed(2) ?? 0);}
async function readFeed(query: string, actor: string) {
 const start = performance.now();
 const rows = await runtime!.begin(async tx => {
  await tx`select set_config('app.member_id',${actor},true)`;
  return tx.unsafe(query);
 });
 const queryMs = performance.now() - start;
 const bytes = Buffer.byteLength(JSON.stringify(rows));
 return {queryMs, totalMs: performance.now() - start, bytes, ids: rows.map(row => row.id), rows: rows.length};
}
async function measure(name: string, query: string) {
 phase = name;
 const plan = await runtime!.begin(async tx => {await tx`select set_config('app.member_id',${member(113)},true)`; return tx.unsafe('explain (analyze,buffers,format json) ' + query);});
 (report as any)[name + '_plan'] = plan[0]['QUERY PLAN'];
 for (const concurrency of [1, 5, 10]) {
  for (let i = 0; i < warmups; i++) await readFeed(query, member((i * 137) % active));
  const observations: Awaited<ReturnType<typeof readFeed>>[] = [], errors: string[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({length: concurrency}, async () => {
   for (;;) {
    const n = next++; if (n >= samples) break;
    try {observations.push(await readFeed(query, member((n * 137) % active)));}
    catch (error) {const code = (error as {code?: string}).code; errors.push(code && /^[A-Z0-9_]+$/.test(code) ? code : 'QUERY_FAILED');}
   }
  }));
  const result = {variant: name, concurrency, samples, successes: observations.length, errors,
   elapsed_ms: Math.round(performance.now() - started),
   query_ms: {p50: percentile(observations.map(v => v.queryMs), .5), p95: percentile(observations.map(v => v.queryMs), .95)},
   including_json_ms: {p50: percentile(observations.map(v => v.totalMs), .5), p95: percentile(observations.map(v => v.totalMs), .95)},
   bytes_per_query: observations.length ? Math.round(observations.reduce((sum, v) => sum + v.bytes, 0) / observations.length) : 0,
   min_rows: observations.length ? Math.min(...observations.map(v => v.rows)) : 0,
  };
  (report.results as unknown[]).push(result); emit(result);
 }
}
async function measureLocalRoute(connectionString: string) {
 // Fixture identity is only injected in this in-process benchmark. No listener
 // is exposed, and production auth / journal middleware are not bypassable.
 const app = new Hono<{Bindings: Env; Variables: Variables}>();
 app.use('*', async (c, next) => {c.set('memberId', c.req.header('x-benchmark-member')!); await next();});
 app.route('/', createSocialRoutes());
 const env = {HYPERDRIVE_SOCIAL: {connectionString}} as unknown as Env;
 async function run(n: number) {
  const start = performance.now();
  const response = await app.request('https://synthetic.invalid/feed', {headers: {'x-benchmark-member': member((n * 137) % active)}}, env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const bytes = await response.arrayBuffer(); const parsed = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(parsed.items.length, 30); assert(parsed.next_cursor);
  return {ms: performance.now() - start, bytes: bytes.byteLength};
 }
 for (const concurrency of [1, 5, 10]) {
  for (let n = 0; n < warmups; n++) await run(n);
  let next = 0; const observations: {ms: number; bytes: number}[] = [], errors: string[] = [];
  const start = performance.now();
  await Promise.all(Array.from({length: concurrency}, async () => {
   for (;;) {const n = next++; if (n >= samples) break; try {observations.push(await run(n));} catch {errors.push('LOCAL_HANDLER_FAILED');}}
  }));
  const result = {variant: 'actual_local_hono_optimized', concurrency, samples, successes: observations.length, errors,
   elapsed_ms: Math.round(performance.now() - start), handler_response_parse_ms: {p50: percentile(observations.map(v => v.ms), .5), p95: percentile(observations.map(v => v.ms), .95)},
   bytes_per_response: observations.length ? Math.round(observations.reduce((sum, v) => sum + v.bytes, 0) / observations.length) : 0,
   excludes: 'Authentication, journal guard, real Hyperdrive, HTTP transport, TLS, compression, client crypto, rendering',
  };
  (report.results as unknown[]).push(result); emit(result);
 }
}
try {
 await admin.unsafe('CREATE DATABASE ' + databaseName); databaseCreated = true;
 // Generated hex credential and identifiers cannot contain SQL delimiters.
 await admin.unsafe(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`); roleCreated = true;
 const ownerUrl = new URL(adminUrl); ownerUrl.pathname = '/' + databaseName;
 owner = postgres(ownerUrl.toString(), {max: 1, prepare: false, fetch_types: false, onnotice: () => {}});
 phase = 'MIGRATE';
 for (const name of (await readdir(new URL('../apps/api/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) await owner.unsafe(await readFile(new URL('../apps/api/migrations/' + name, import.meta.url), 'utf8'));
 await admin.unsafe(`GRANT porchday_social TO ${role}`);
 // Reproduce the pre-034 access path only inside this disposable fixture.
 await owner`drop index if exists app.post_recipients_member`;
 const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = role; runtimeUrl.password = password;
 runtime = postgres(runtimeUrl.toString(), {max: 10, prepare: false, fetch_types: false, onnotice: () => {}, connection: {statement_timeout: 60_000}});
 report.postgres_version = (await owner`select version()`)[0].version;
 const [identity] = await runtime`select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
 assert.equal(identity.rolsuper, false); assert.equal(identity.rolbypassrls, false);
 await assert.rejects(runtime`select * from public.auth_session`, {code: '42501'});
 phase = 'SEED_MEMBERS_CONNECTIONS'; emit({phase});
 await owner.unsafe(`insert into app.members(id,adult_attested_at,rules_accepted_at) select ${memberSql('i')},now(),now() from generate_series(0,${registered - 1}) i`);
 await owner.unsafe(`insert into app.profiles(member_id,handle) select ${memberSql('i')},'benchmark_'||i from generate_series(0,${registered - 1}) i`);
 await owner.unsafe(`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) select ${deviceSql('i')},${memberSql('i')},repeat('synthetic-not-a-public-key-',5),lpad(to_hex(i),40,'0'),'{}'::jsonb from generate_series(0,${registered - 1}) i`);
 await owner.unsafe(`insert into app.connections(member_a,member_b,kind)
 select least(${memberSql('i')},${memberSql('(i+j)%' + active)}),greatest(${memberSql('i')},${memberSql('(i+j)%' + active)}),case when j%7=0 then 'family' else 'friend' end
 from generate_series(0,${active - 1}) i cross join generate_series(1,${neighbors}) j`);
 phase = 'SEED_POSTS'; emit({phase});
 const baselineTime = Date.now() - 2 * 86_400_000;
 for (let offset = 0; offset < registered; offset += 50) {
  const records = Array.from({length: Math.min(50, registered - offset)}, (_, j) => {
   const i = offset + j, audience = i < active ? 'connections' : 'only_me';
   const created_at = new Date(baselineTime + ((i * 7919) % registered) * 1000).toISOString();
   return {id: post(i), author_id: member(i), audience, epoch: 1, created_at,
    envelope: {v: 1, protocol: 'synthetic-query-benchmark-invalid-openpgp', context: {id: post(i), kind: 'post', authorId: member(i), authorDeviceId: device(i), audience, parentId: null, groupId: null, epoch: 1, createdAt: created_at, expiresAt: null, revision: 1}, recipients: [], ciphertext: randomBytes(i < active ? 75 * 1024 : 768).toString('base64')},
   };
  });
  await owner`insert into app.posts ${owner(records, 'id', 'author_id', 'audience', 'epoch', 'created_at', 'envelope')}`;
 }
 phase = 'SEED_RECIPIENTS'; emit({phase});
 await owner.unsafe(`insert into app.post_recipients(post_id,device_id,member_id)
 select ${postSql('i')},${deviceSql('i')},${memberSql('i')} from generate_series(0,${registered - 1}) i
 union all select p.id,d.id,d.member_id from app.posts p join app.connections c on p.author_id in(c.member_a,c.member_b)
 join app.device_keys d on d.member_id=case when c.member_a=p.author_id then c.member_b else c.member_a end`);
 await owner`analyze`;
 const [counts] = await owner`select (select count(*)::int from app.connections) connections,(select count(*)::int from app.post_recipients) post_recipients,pg_database_size(current_database()) database_bytes`;
 report.database = counts; emit({phase: 'SEEDED', ...counts});
 assert.equal(counts.connections, active * neighbors); assert.equal(counts.post_recipients, active * (2 * neighbors + 1) + registered - active);
 const denied = await readFeed(baseQuery, member(registered - 1)); assert.equal(denied.rows, 1);
 const before = await readFeed(baseQuery, member(113)); assert.equal(before.rows, 31);
 await measure('baseline', baseQuery);
 phase = 'ADD_RECIPIENT_INDEX'; await owner`create index benchmark_recipients_member on app.post_recipients(post_id,member_id)`; await owner`analyze app.post_recipients`;
 await measure('recipient_index', baseQuery);
 for (const actor of [0, 113, 499, 999, registered - 1]) assert.deepEqual((await readFeed(candidateQuery, member(actor))).ids, (await readFeed(baseQuery, member(actor))).ids);
 await measure('recipient_index_author_candidates', candidateQuery);
 phase = 'ACTUAL_LOCAL_HONO'; await measureLocalRoute(runtimeUrl.toString());
 report.passed = (report.results as {errors: string[]}[]).every(r => r.errors.length === 0);
 await writeFile(new URL('../docs/feed-benchmark-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
 emit({passed: report.passed, report: 'docs/feed-benchmark-results.json', cleanup: 'disposable database and role removed in finally'});
 if (!report.passed) process.exitCode = 1;
} catch (error) {
 const code = (error as {code?: string}).code;
 emit({passed: false, phase, code: code && /^[A-Z0-9_]+$/.test(code) ? code : 'LOCAL_BENCHMARK_FAILED'});
 process.exitCode = 1;
} finally {
 await runtime?.end({timeout: 1}); await owner?.end({timeout: 1});
 if (databaseCreated) await admin.unsafe('DROP DATABASE ' + databaseName + ' WITH (FORCE)');
 if (roleCreated) await admin.unsafe('DROP ROLE ' + role);
 await admin.end({timeout: 1});
}
