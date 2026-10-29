import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {serializeSignedCookie} from 'better-call';
import {hashPassword} from 'better-auth/crypto';
import {Hono} from 'hono';
import {createAuth} from '../src/auth';
import {prepareMemberAuth,requireMember,requireAppealMember} from '../src/session';
import {authRoutes} from '../src/auth-routes';
import {persistSessionDenial} from '../src/session-denial';
import {cleanupDeniedSessions,deleteDeniedSession} from '../src/session-denial-cleanup';
import {denialProgressKey,readDenialCleanupHealth} from '../src/session-denial-progress';
import {listSessionCandidates,cleanupDeniedSessionCandidates,candidateProgressKey,parseCandidateProgress,readCandidateCleanupHealth} from '../src/session-denial-candidates';
import type {Env,Variables} from '../src/types';

const base=process.env.TEST_DATABASE_URL;
const suite=base?describe:describe.skip;
const suffix=randomUUID().replaceAll('-','');
const database='porchday_session_joins_'+suffix,role='porchday_session_auth_'+suffix;
let admin:Pool,owner:Pool,env:Env;
const runtimePools:Pool[]=[];
type QueryKind='schema_path'|'schema_columns'|'joined_session_user'|'session'|'user'|'member_status'|'other';
function runtimePool(){
 const pool=new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString,max:1});
 const queries:QueryKind[]=[];runtimePools.push(pool);
 pool.on('connect',client=>{
  const original=client.query.bind(client);
  client.query=((...args:unknown[])=>{
   const input=args[0] as string|{text?:string},sql=typeof input==='string'?input:input.text??'';
   // Only fixed categories are retained; never query arguments, cookies, tokens or raw SQL.
   queries.push(/current_schemas/i.test(sql)?'schema_path':/pg_catalog|information_schema/i.test(sql)?'schema_columns':
    /left join/i.test(sql)&&/auth_session/.test(sql)?'joined_session_user':/auth_session/.test(sql)?'session':
    /auth_user/.test(sql)?'user':/auth_member_status/.test(sql)?'member_status':'other');
   return Reflect.apply(original,client,args);
  }) as typeof client.query;
 });
 return {pool,queries};
}
async function person(){
 const memberId=randomUUID(),sessionId=randomUUID(),token=randomUUID();
 await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[memberId,'Synthetic session',memberId+'@example.test']);
 await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[memberId,'j_'+memberId.replaceAll('-','').slice(0,16)]);
 const result=await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()+interval\'7 days\',$2,$3) RETURNING "createdAt"',[sessionId,token,memberId]);
 const cookie=(await serializeSignedCookie('better-auth.session_token',token,env.BETTER_AUTH_SECRET)).split(';')[0];
 return {memberId,sessionId,token,cookie,headers:new Headers({cookie}),createdAt:result.rows[0].createdAt as Date};
}
suite('joined session reads through the restricted PostgreSQL auth role',()=>{
 beforeAll(async()=>{
  const url=new URL(base!);
  if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Disposable loopback database required');
  url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});
  await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
  owner=new Pool({connectionString:url.href,max:1});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
   await owner.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-session-joins' IN ROLE porchday_auth`);
  url.username=role;url.password='synthetic-session-joins';
  env={APP_URL:'http://localhost:8787',ENVIRONMENT:'development',BETTER_AUTH_SECRET:'synthetic-session-key-more-than-thirty-two-characters',HYPERDRIVE_AUTH:{connectionString:url.href}} as unknown as Env;
 },30000);
 afterAll(async()=>{
  await Promise.all(runtimePools.map(pool=>pool.end()));
  if(owner)await owner.end();
  if(admin)try{
   // pg.Pool.end() can resolve after sending Terminate but before PostgreSQL
   // removes the backend. FORCE would kill that closing socket and emit an
   // unhandled 57P01; wait for actual disconnects instead of hiding that error.
   let drained=false;
   for(let attempt=0;attempt<200;attempt++){
    const {rows}=await admin.query('SELECT count(*)::integer AS remaining FROM pg_stat_activity WHERE datname=$1',[database]);
    if(rows[0].remaining===0){drained=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   if(!drained)throw Error('DISPOSABLE_DATABASE_CONNECTIONS_DID_NOT_DRAIN');
   await admin.query('DROP DATABASE IF EXISTS '+database);
   await admin.query('DROP ROLE IF EXISTS '+role);
  }finally{await admin.end();}
 });
 it.each([false,true])('uses one session/user query and retains schema/status reads (transaction config=%s)',async inTransaction=>{
  const actor=await person(),other=await person(),{pool,queries}=runtimePool();
  const auth=createAuth(env,pool,undefined,inTransaction);
  const result=await auth.api.getSession({headers:actor.headers});
  expect(result?.user.id).toBe(actor.memberId);expect(result?.user.id).not.toBe(other.memberId);
  expect(result?.session.id).toBe(actor.sessionId);expect(result?.session.createdAt).toEqual(actor.createdAt);
  expect(result?.user.emailVerified).toBe(true);
  expect((await pool.query('SELECT app.auth_member_status($1::uuid) AS status',[actor.memberId])).rows[0].status).toBe('active');
  expect(queries).toEqual(['schema_path','schema_columns','joined_session_user','member_status']);
  // A reused auth object still reads session/user anew: no cookie or adapter result cache.
  queries.length=0;
  expect((await auth.api.getSession({headers:other.headers}))?.user.id).toBe(other.memberId);
  expect(queries).toEqual(['joined_session_user']);
 });
 it('observes verification changes, expired sessions and immediate revocation without trusting a previous result',async()=>{
  const actor=await person(),{pool,queries}=runtimePool(),auth=createAuth(env,pool);
  expect((await auth.api.getSession({headers:actor.headers}))?.user.emailVerified).toBe(true);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=false WHERE id=$1',[actor.memberId]);
  expect((await auth.api.getSession({headers:actor.headers}))?.user.emailVerified).toBe(false);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[actor.memberId]);
  await owner.query('UPDATE public.auth_session SET "expiresAt"=now()-interval\'1 second\' WHERE id=$1',[actor.sessionId]);
  expect(await auth.api.getSession({headers:actor.headers})).toBeNull();
  await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()+interval\'7 days\',$2,$3) ON CONFLICT(id) DO UPDATE SET "expiresAt"=excluded."expiresAt"',[actor.sessionId,actor.token,actor.memberId]);
  expect((await auth.api.getSession({headers:actor.headers}))?.session.id).toBe(actor.sessionId);
  await owner.query('DELETE FROM public.auth_session WHERE id=$1',[actor.sessionId]);
  expect(await auth.api.getSession({headers:actor.headers})).toBeNull();
  queries.length=0;
  expect(await auth.api.getSession({headers:new Headers({cookie:'better-auth.session_token=invalid'})})).toBeNull();
  expect(queries).toEqual([]);
 });
 it('keeps current membership, verified-email, appeal and recent-auth boundaries in the real middleware',async()=>{
  const actor=await person(),pending:Promise<unknown>[]=[];
  const context={waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext;
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.use('*',prepareMemberAuth);
  app.get('/api/v1/me',requireMember,c=>c.json({id:c.get('sessionId')}));
  app.get('/api/v1/feed',requireMember,c=>c.json({memberId:c.get('memberId'),authTime:c.get('authTime')}));
  app.get('/api/v1/me',requireMember,c=>c.json({memberId:c.get('memberId')}));
  app.get('/appeals',requireAppealMember,c=>c.json({memberId:c.get('memberId')}));
  app.route('/api/auth',authRoutes);
  const call=async(path:string,body?:unknown)=>{
   try{return await app.fetch(new Request(env.APP_URL+path,{method:body?'POST':'GET',headers:{Cookie:actor.cookie,Origin:env.APP_URL,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,context);}
   finally{await Promise.allSettled(pending.splice(0));}
  };
  expect(await(await call('/api/v1/feed')).json()).toEqual({memberId:actor.memberId,authTime:actor.createdAt.getTime()});
  await owner.query('UPDATE public.auth_user SET "emailVerified"=false WHERE id=$1',[actor.memberId]);
  expect((await call('/api/v1/feed')).status).toBe(401);
  await owner.query('UPDATE public.auth_user SET "emailVerified"=true WHERE id=$1',[actor.memberId]);
  await owner.query("UPDATE app.members SET status='suspended' WHERE id=$1",[actor.memberId]);
  expect((await call('/api/v1/feed')).status).toBe(403);expect((await call('/api/v1/me')).status).toBe(200);expect((await call('/appeals')).status).toBe(200);
  await owner.query("UPDATE app.members SET status='hold' WHERE id=$1",[actor.memberId]);
  expect((await call('/api/v1/me')).status).toBe(403);expect((await call('/appeals')).status).toBe(403);
  await owner.query("UPDATE app.members SET status='active' WHERE id=$1",[actor.memberId]);
  const old=await owner.query('UPDATE public.auth_session SET "createdAt"=now()-interval\'20 minutes\' WHERE id=$1 RETURNING "createdAt"',[actor.sessionId]);
  expect(await(await call('/api/v1/feed')).json()).toEqual({memberId:actor.memberId,authTime:old.rows[0].createdAt.getTime()});
  const recent=await call('/api/auth/change-password',{currentPassword:'synthetic-current-password',newPassword:'synthetic-next-password'});
  expect(recent.status).toBe(403);expect(await recent.json()).toMatchObject({error:{code:'RECENT_AUTH_REQUIRED'}});
 });
 it('rejects denied sessions through member and appeal HTTP routes even after a SQL row is restored',async()=>{
  const actor=await person(),other=await person(),pending:Promise<unknown>[]=[];
  const records=new Map<string,string>();
  const store={get:async(key:string)=>records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null,
   put:async(key:string,text:string)=>{if(records.has(key))return null;records.set(key,text);return {etag:'record'};}};
  const guardedEnv={...env,RECOVERY_JOURNAL:store} as unknown as Env;
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.use('*',prepareMemberAuth);
  app.get('/api/v1/me',requireMember,c=>c.json({id:c.get('sessionId')}));
  app.get('/api/v1/feed',requireMember,c=>c.json({id:c.get('sessionId')}));
  app.get('/appeals',requireAppealMember,c=>c.json({id:c.get('sessionId')}));
  const context={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as ExecutionContext;
  const call=async(path:string,cookie=actor.cookie)=>{
   try{return await app.fetch(new Request(env.APP_URL+path,{headers:{cookie}}),guardedEnv,context);}
   finally{await Promise.all(pending.splice(0));}
  };
  expect((await call('/api/v1/feed')).status).toBe(200);
  await persistSessionDenial(store,actor.sessionId);
  // Publication followed by a process loss leaves the real SQL row untouched.
  expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(1);
  for(const path of ['/api/v1/me','/api/v1/feed','/appeals']){
   expect((await call(path)).status).toBe(401);expect((await call(path,other.cookie)).status).toBe(200);
  }
  await owner.query('DELETE FROM public.auth_session WHERE id=$1',[actor.sessionId]);
  await owner.query(`INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()+interval '7 days',$2,$3)`,[actor.sessionId,actor.token,actor.memberId]);
  for(const path of ['/api/v1/me','/api/v1/feed','/appeals'])expect((await call(path)).status).toBe(401);
 });

 it('enforces denials inside SDK endpoints and permits a fresh credential login with the denied cookie',async()=>{
  const actor=await person(),other=await person(),{pool}=runtimePool(),records=new Map<string,string>();
  let reads=0,fail=false;
  const store={get:async(key:string)=>{reads++;if(fail)throw Error('private provider error');return records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null;},
   put:async(key:string,text:string)=>{if(records.has(key))return null;records.set(key,text);return {etag:'record'};}};
  const guardedEnv={...env,RECOVERY_JOURNAL:store} as unknown as Env,auth=createAuth(guardedEnv,pool);
  const originalAdapter=(await auth.$context).internalAdapter;
  const call=(path:string,body?:unknown,cookie=actor.cookie)=>auth.handler(new Request(env.APP_URL+'/api/auth/'+path,{method:body?'POST':'GET',headers:{cookie,Origin:env.APP_URL,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}));
  expect((await auth.api.getSession({headers:actor.headers}))?.session.id).toBe(actor.sessionId);
  expect(reads).toBe(1);
  await persistSessionDenial(store,actor.sessionId);
  expect(await auth.api.getSession({headers:actor.headers})).toBeNull();
  expect(await(await call('get-session')).json()).toBeNull();
  for(const [path,body] of [['list-sessions',undefined],['change-password',{currentPassword:'old-password',newPassword:'synthetic-new-password'}],['two-factor/enable',{password:'synthetic-password'}]] as const)
   expect((await call(path,body)).status).toBe(401);
  expect((await auth.api.getSession({headers:other.headers}))?.session.id).toBe(other.sessionId);
  // Optional-session email verification must take the anonymous branch for a
  // denied cookie. Both fixture accounts are verified, so no email is sent.
  expect((await call('send-verification-email',{email:other.memberId+'@example.test'})).status).toBe(200);
  expect((await auth.$context).internalAdapter).toBe(originalAdapter);
  const password='synthetic-denial-fresh-password';
  await owner.query(`INSERT INTO public.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,[randomUUID(),actor.memberId,await hashPassword(password)]);
  const login=await call('sign-in/email',{email:actor.memberId+'@example.test',password});
  expect(login.status).toBe(200);
  const cookie=login.headers.getSetCookie().find(value=>value.startsWith('better-auth.session_token='))?.split(';')[0];
  expect(cookie).toBeTruthy();
  const fresh=await auth.api.getSession({headers:new Headers({cookie:cookie!})});
  expect(fresh?.user.id).toBe(actor.memberId);expect(fresh?.session.id).not.toBe(actor.sessionId);
  expect(await auth.api.getSession({headers:actor.headers})).toBeNull();
  fail=true;
  const unavailable=await call('get-session');expect(unavailable.status).toBe(503);expect(await unavailable.text()).not.toContain('private');
 });
 it('enforces the SDK guard through the application auth router, including non-preflight session endpoints',async()=>{
  const actor=await person(),records=new Map<string,string>(),pending:Promise<unknown>[]=[];
  const store={get:async(key:string)=>records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null,
   put:async(key:string,text:string)=>{if(records.has(key))return null;records.set(key,text);return {etag:'record'};}};
  const guardedEnv={...env,RECOVERY_JOURNAL:store} as unknown as Env;
  await persistSessionDenial(store,actor.sessionId);
  const app=new Hono<{Bindings:Env;Variables:Variables}>();app.route('/api/auth',authRoutes);
  const context={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as ExecutionContext;
  for(const [path,body,status] of [['get-session',undefined,200],['list-sessions',undefined,401],['change-password',{currentPassword:'old-password',newPassword:'synthetic-new-password'},401],['two-factor/enable',{password:'synthetic-password'},401]] as const){
   const response=await app.fetch(new Request(env.APP_URL+'/api/auth/'+path,{method:body?'POST':'GET',headers:{cookie:actor.cookie,Origin:env.APP_URL,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),guardedEnv,context);
   await Promise.all(pending.splice(0));expect(response.status).toBe(status);
   if(path==='get-session')expect(await response.json()).toBeNull();
  }
 });

 it.each(['production','staging','development'] as const)('fails closed for hosted missing bindings and storage errors in %s',async environment=>{
  const actor=await person(),pending:Promise<unknown>[]=[];
  let mode:'missing'|'failure'|'conflict'='missing';
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.use('*',prepareMemberAuth);
  app.get('/api/v1/me',requireMember,c=>c.json({id:c.get('sessionId')}));
  app.get('/api/v1/feed',requireMember,c=>c.json({id:c.get('sessionId')}));
  app.get('/appeals',requireAppealMember,c=>c.json({id:c.get('sessionId')}));
  app.onError((_,c)=>c.json({error:{code:'SERVICE_UNAVAILABLE'}},503));
  const context={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as ExecutionContext;
  const call=async(path:string)=>{
   const guardedEnv={...env,ENVIRONMENT:environment,...(mode==='missing'?{}:{RECOVERY_JOURNAL:{get:async()=>{if(mode==='failure')throw Error('private provider error');return {etag:'record',text:async()=>'{}'};}}})} as unknown as Env;
   try{return await app.fetch(new Request(env.APP_URL+path,{headers:{cookie:actor.cookie}}),guardedEnv,context);}
   finally{await Promise.all(pending.splice(0));}
  };
  for(const nextMode of ['missing','failure','conflict'] as const){
   mode=nextMode;
   for(const path of ['/api/v1/me','/api/v1/feed','/appeals']){
    const response=await call(path);expect(response.status).toBe(mode==='missing'&&environment==='development'?200:503);
    expect(await response.text()).not.toContain('private');
   }
  }
 });

 it('sweeps a confirmed denial through the restricted auth role without deleting another session',async()=>{
  const actor=await person(),other=await person(),records=new Map<string,string>();
  const store={get:async(key:string)=>records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null,
   put:async(key:string,text:string,options?:{onlyIf?:{etagDoesNotMatch?:string;etagMatches?:string}})=>{if(options?.onlyIf?.etagDoesNotMatch==='*'&&records.has(key)||options?.onlyIf?.etagMatches&&(!records.has(key)||options.onlyIf.etagMatches!=='record'))return null;records.set(key,text);return {etag:'record'};},
   list:async({prefix}:{prefix:string})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false})};
  await persistSessionDenial(store,actor.sessionId);
  const guardedEnv={...env,SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:store} as unknown as Env;
  expect((await cleanupDeniedSessions(guardedEnv)).deleted).toBe(1);
  expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(0);
  expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[other.sessionId])).rowCount).toBe(1);
  expect((await cleanupDeniedSessions(guardedEnv)).deleted).toBe(0);expect(records.size).toBe(2);
  expect((await readDenialCleanupHealth(guardedEnv)).issues).toEqual([]);
 });
 it('discovers expired and restored SQL sessions through the restricted role with indexed keyset pages',async()=>{
  const actor=await person(),other=await person(),{pool}=runtimePool(),records=new Map<string,{etag:string;text:string}>();let version=0;
  const store={get:async(key:string)=>{const row=records.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;},
   put:async(key:string,text:string,options?:{onlyIf?:{etagDoesNotMatch?:string;etagMatches?:string}})=>{
    const old=records.get(key),condition=options?.onlyIf;
    if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
    const etag=String(++version);records.set(key,{etag,text});return {etag};
   }};
  // More than one page, all synthetic and owned by this disposable database.
  await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") SELECT gen_random_uuid()::text,now()-interval\'1 day\',gen_random_uuid()::text,$1 FROM generate_series(1,110)',[actor.memberId]);
  await owner.query('UPDATE public.auth_session SET "expiresAt"=now()-interval\'1 day\' WHERE id=$1',[actor.sessionId]);
  const expected=(await owner.query('SELECT id FROM public.auth_session ORDER BY id')).rows.map(row=>row.id);
  const first=await listSessionCandidates(pool,null),second=await listSessionCandidates(pool,first.ids.at(-1)!);
  expect(first.ids).toHaveLength(100);expect(first.more).toBe(true);expect(second.more).toBe(false);
  expect([...first.ids,...second.ids]).toEqual(expected);expect(expected).toContain(actor.sessionId);
  await persistSessionDenial(store,actor.sessionId);
  const candidateEnv={...env,SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:store} as unknown as Env;
  const sweep=()=>cleanupDeniedSessionCandidates(candidateEnv);
  let deleted=0;
  do{deleted+=(await sweep()).deleted;}while(parseCandidateProgress(records.get(candidateProgressKey)!.text).cursor!==null);
  expect(deleted).toBe(1);expect((await pool.query('SELECT 1 FROM public.auth_session WHERE id=$1',[other.sessionId])).rowCount).toBe(1);
  await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()-interval\'1 day\',$2,$3)',[actor.sessionId,actor.token,actor.memberId]);
  deleted=0;do{deleted+=(await sweep()).deleted;}while(parseCandidateProgress(records.get(candidateProgressKey)!.text).cursor!==null);
  expect(deleted).toBe(1);expect((await pool.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(0);
  expect((await readCandidateCleanupHealth(candidateEnv)).issues).toEqual([]);
  // Confirm the keyset can use the existing primary-key index. Disabling a
  // sequential scan here tests index eligibility, not production planner cost.
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query('SET LOCAL enable_seqscan=off');
   const plan=await client.query('EXPLAIN (FORMAT JSON) SELECT id FROM public.auth_session WHERE id>$1 ORDER BY id LIMIT 101',[first.ids.at(-1)]);
   expect(JSON.stringify(plan.rows[0]['QUERY PLAN'])).toContain('auth_session_pkey');await client.query('ROLLBACK');
  }finally{client.release();}
 });
 it('orders exact cleanup behind an existing identity operation and can retry a lost commit reply',async()=>{
  const actor=await person(),other=await person(),{pool}=runtimePool(),lock=await owner.connect();
  let cleanup:Promise<boolean>|undefined;
  try{
   await lock.query('BEGIN');await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[actor.memberId]);
   cleanup=deleteDeniedSession(pool,actor.sessionId);void cleanup.catch(()=>{});
   await vi.waitFor(async()=>{expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",[role])).rowCount).toBeGreaterThan(0);});
   expect((await lock.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(1);
   await lock.query('COMMIT');expect(await cleanup).toBe(true);
  }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();if(cleanup)await cleanup.catch(()=>{});}
  const lostReplyPool={connect:async()=>{
   const client=await pool.connect();return {release:(failed?:boolean)=>client.release(failed),query:async(input:{text:string;values?:unknown[];query_timeout?:number})=>{const value=await client.query(input);if(input.text==='COMMIT')throw Error('lost acknowledgement');return value;}};
  }} as unknown as Pool;
  await expect(deleteDeniedSession(lostReplyPool,other.sessionId)).rejects.toThrow('SESSION_DENIAL_CLEANUP_UNAVAILABLE');
  expect(await deleteDeniedSession(pool,other.sessionId)).toBe(false);
 });

 it('clears cookies through a server-only SDK endpoint without a session mutation or public route',async()=>{
  const actor=await person(),{pool,queries}=runtimePool(),auth=createAuth(env,pool);
  // Logout preflight resolves schema and the verified session before cleanup.
  await auth.api.getSession({headers:actor.headers});queries.length=0;
  const response=await auth.api.clearDeniedSessionCookies({headers:actor.headers,asResponse:true});
  expect(response.status).toBe(200);expect(queries).toEqual([]);
  expect(response.headers.getSetCookie().some(value=>value.startsWith('better-auth.session_token=;')&&/Max-Age=0/i.test(value))).toBe(true);
  expect((await auth.api.getSession({headers:actor.headers}))?.session.id).toBe(actor.sessionId);
  const exposed=await auth.handler(new Request(env.APP_URL+'/api/auth/clearDeniedSessionCookies',{method:'POST',headers:{Origin:env.APP_URL,'Content-Type':'application/json'},body:'{}'}));
  expect(exposed.status).toBe(404);
 });

 it('recovers in a fresh process after SIGKILL between native R2 publication and SQL cleanup',async()=>{
  const actor=await person(),other=await person();
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-10-01',r2Buckets:['JOURNAL']}));
  const bucket=await mf.getR2Bucket('JOURNAL');
  const key='session-denials/v1/'+createHash('sha256').update('porchday-session-denial-v1\0'+actor.sessionId).digest('hex')+'.json';
  const bearer=randomUUID(),control='synthetic-global-control-unchanged';await bucket.put('control.json',control);
  let publications=0;
  const server=createServer(async(request,response)=>{
   try{
    if(request.headers.authorization!=='Bearer '+bearer){response.writeHead(401).end();return;}
    let body='';for await(const chunk of request){body+=chunk;if(body.length>4096)throw Error();}
    const {operation,args}=JSON.parse(body);let result:unknown;
    if(operation==='get'&&(args[0]===candidateProgressKey||/^session-denials\/v1\/[a-f0-9]{64}\.json$/.test(args[0]))){const row=await bucket.get(args[0]);result=row?{etag:row.etag,value:await row.text()}:null;}
    else if(operation==='put'&&[key,candidateProgressKey].includes(args[0])){if(args[0]===key)publications++;result=await bucket.put(args[0],args[1],args[2]);result=result?{etag:(result as {etag:string}).etag}:null;}
    else throw Error();
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify(result));
   }catch{response.writeHead(500).end();}
  });
  const children:ReturnType<typeof fork>[]=[];
  try{
   server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};
   const start=(action:'publish'|'cleanup')=>{
    const child=fork(fileURLToPath(new URL('./fixtures/session-denial-process.ts',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});children.push(child);
    const message=new Promise<any>((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('SUBPROCESS_MESSAGE_TIMEOUT')),10000);
     child.once('message',value=>{clearTimeout(timer);resolve(value);});
     child.once('error',error=>{clearTimeout(timer);reject(error);});
     child.once('exit',()=>{clearTimeout(timer);reject(Error('SUBPROCESS_EXITED_BEFORE_MESSAGE'));});
    });
    child.send({action,url:'http://127.0.0.1:'+address.port,bearer,sessionId:actor.sessionId,database:env.HYPERDRIVE_AUTH.connectionString});return {child,message};
   };
   const writer=start('publish');expect(await writer.message).toEqual({phase:'denial-confirmed'});
   const stopped=once(writer.child,'exit');writer.child.kill('SIGKILL');expect(await stopped).toEqual([null,'SIGKILL']);
   expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(1);
   const {pool}=runtimePool(),auth=createAuth({...env,RECOVERY_JOURNAL:bucket} as unknown as Env,pool);
   expect(await auth.api.getSession({headers:actor.headers})).toBeNull();
   expect((await auth.api.getSession({headers:other.headers}))?.user.id).toBe(other.memberId);
   for(const deleted of [1,0]){
    const expectedSeen=Number((await owner.query('SELECT count(*) AS count FROM public.auth_session')).rows[0].count);
    const recovery=start('cleanup'),exited=once(recovery.child,'exit');
    expect(await recovery.message).toMatchObject({phase:'cleanup-complete',result:{seen:expectedSeen,deleted,invalid:0}});
    expect(await exited).toEqual([0,null]);
   }
   expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[actor.sessionId])).rowCount).toBe(0);
   expect((await auth.api.getSession({headers:other.headers}))?.user.id).toBe(other.memberId);
   expect(await(await bucket.get('control.json'))!.text()).toBe(control);
   expect(await bucket.get(key)).not.toBeNull();expect(publications).toBe(1);
   expect((await readCandidateCleanupHealth({SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:bucket} as unknown as Env)).issues).toEqual([]);
  }finally{
   for(const child of children)if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}
   server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await mf.dispose();
  }
 },30000);

});
