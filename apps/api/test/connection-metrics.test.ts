import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {routePath} from 'hono/route';
import {Pool} from 'pg';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {connectionScope,trackPool,trackPostgres,connectionRefusal,reportConnectionRefusal} from '../src/connection-metrics';
import {recordConnectionSnapshot} from '../src/connection-snapshot';
import type {Env,Variables} from '../src/types';

const unreachable='postgres://nobody@127.0.0.1:1/none';
function metrics(){
 const writeDataPoint=vi.fn();
 const env={ENVIRONMENT:'production',METRICS:{writeDataPoint}} as unknown as Env;
 const points=()=>writeDataPoint.mock.calls.map(([point])=>({route:point.blobs[3],code:point.blobs[5],held:point.doubles[1],count:point.doubles[2],after:point.doubles[3]}));
 return {env,points};
}

test('a request reports each connection with its route pattern, hold time and time held after the response',async()=>{
 const {env,points}=metrics();
 let deferred:Promise<void>=Promise.resolve();
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('/api/*',(c,next)=>connectionScope('none',()=>next(),()=>routePath(c)));
 app.get('/api/v1/media/:id/bytes',async c=>{
  const sql=trackPostgres(c.env,'social',postgres(unreachable,{max:1}));
  await sql.end();
  const pool=trackPool(c.env,'auth',new Pool({connectionString:unreachable,max:3}));
  pool.emit('connect',{} as never);pool.emit('connect',{} as never);
  // Like requireMember: the auth pool closes in waitUntil, after the response.
  deferred=new Promise(resolve=>setTimeout(resolve,15)).then(()=>pool.end());
  return c.text('ok');
 });
 expect((await app.request('/api/v1/media/'+randomUUID()+'/bytes',{},env)).status).toBe(200);
 await deferred;
 const all=points();
 expect(all.every(point=>point.route==='/api/v1/media/:id/bytes')).toBe(true);
 expect(all.map(point=>point.code)).toEqual(['social_open','social_close','auth_open','auth_open','auth_open_at_response','auth_close']);
 const authClose=all.find(point=>point.code==='auth_close')!;
 expect(authClose.count).toBe(2);expect(authClose.held).toBeGreaterThanOrEqual(10);expect(authClose.after).toBeGreaterThanOrEqual(10);
 expect(all.find(point=>point.code==='auth_open_at_response')!.count).toBe(2);
 // Closed before the response: no after-response time.
 expect(all.find(point=>point.code==='social_close')!.after).toBeUndefined();
 expect(JSON.stringify(all)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test('jobs are labelled, unscoped clients still report, and closing twice counts once',async()=>{
 const {env,points}=metrics();
 await connectionScope('job:queue',async()=>{const sql=trackPostgres(env,'jobs',postgres(unreachable,{max:1}));await sql.end();await sql.end();});
 const loose=trackPostgres(env,'social',postgres(unreachable,{max:1}));await loose.end();
 expect(points().map(point=>[point.route,point.code])).toEqual([['job:queue','jobs_open'],['job:queue','jobs_close'],['none','social_open'],['none','social_close']]);
});

test('connection refusals are classified from codes and messages without copying them',()=>{
 expect(connectionRefusal(Object.assign(Error('sorry'),{code:'53300'}))).toBe('refused_53300');
 expect(connectionRefusal(Error('sorry, too many clients already'))).toBe('refused_53300');
 expect(connectionRefusal(Object.assign(Error('x'),{code:'CONNECT_TIMEOUT'}))).toBe('connect_timeout');
 expect(connectionRefusal(Error('Hyperdrive: failed to acquire a connection from the pool'))).toBe('refused_hyperdrive');
 expect(connectionRefusal(Error('wrapped',{cause:Object.assign(Error('inner'),{code:'53400'})}))).toBe('refused_53400');
 expect(connectionRefusal(Error('duplicate key'))).toBeUndefined();
 const {env,points}=metrics();
 reportConnectionRefusal(env,Error('too many connections for role "member@example.test"'));
 expect(points()).toEqual([{route:'none',code:'refused_53300',held:-1,count:1,after:undefined}]);
});

const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('connection snapshot against PostgreSQL',()=>{
 const role='porchday_snapshot_'+randomUUID().replaceAll('-','').slice(0,12),password=randomUUID();
 let owner:postgres.Sql;
 beforeAll(async()=>{
  owner=postgres(url!,{max:1,onnotice:()=>{}});
  await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT IN ROLE porchday_jobs`);
 });
 afterAll(async()=>{await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);await owner.end();});
 test('a runtime jobs login records counts by role and state, and refusal is reported as such',async()=>{
  const target=new URL(url!);target.username=role;target.password=password;
  // A second jobs session left idle in a transaction must be visible.
  const idle=postgres(target.href,{max:1});
  const reserved=await idle.reserve();await reserved`begin`;await reserved`select 1`;
  try{
   const {env,points}=metrics();
   await recordConnectionSnapshot({...env,HYPERDRIVE_JOBS:{connectionString:target.href}} as Env);
   const snapshot=points().filter(point=>!point.code.startsWith('jobs_open')&&!point.code.startsWith('jobs_close'));
   expect(snapshot.find(point=>point.code==='max_connections')!.count).toBeGreaterThan(0);
   expect(snapshot.find(point=>point.code==='jobs_idle_in_transaction')!.count).toBeGreaterThanOrEqual(1);
   expect(snapshot.find(point=>point.code==='jobs_active')!.count).toBeGreaterThanOrEqual(1);
   for(const point of snapshot)expect(point.route).toBe('job:cron');
  }finally{await reserved`rollback`;reserved.release();await idle.end();}
  const {env,points}=metrics();
  await recordConnectionSnapshot({...env,HYPERDRIVE_JOBS:{connectionString:unreachable}} as Env);
  expect(points().map(point=>point.code)).toContain('snapshot_failed');
 });
 test('runtime roles other than jobs cannot read the snapshot',async()=>{
  const other='porchday_social_probe_'+randomUUID().replaceAll('-','').slice(0,8);
  await owner.unsafe(`CREATE ROLE ${other} LOGIN PASSWORD '${password}' INHERIT IN ROLE porchday_social`);
  const target=new URL(url!);target.username=other;target.password=password;
  const social=postgres(target.href,{max:1});
  try{await expect(social`select app.connection_snapshot()`).rejects.toMatchObject({code:'42501'});}
  finally{await social.end();await owner.unsafe(`DROP ROLE ${other}`);}
 });
 test('superuser backends are other, even though pg_has_role says they have every runtime role',async()=>{
  const admin=postgres(url!,{max:1}),reserved=await admin.reserve();
  await reserved`begin read only`;
  try{
   const [identity]=await reserved`select rolsuper,pg_has_role(current_user,'porchday_auth','USAGE') as auth from pg_roles where rolname=current_user`;
   expect(identity).toMatchObject({rolsuper:true,auth:true});
   const target=new URL(url!);target.username=role;target.password=password;
   const {env,points}=metrics();
   await recordConnectionSnapshot({...env,HYPERDRIVE_JOBS:{connectionString:target.href}} as Env);
   expect(points().find(point=>point.code==='other_idle_in_transaction')?.count).toBeGreaterThanOrEqual(1);
  }finally{await reserved`rollback`;reserved.release();await admin.end();}
 });
});
