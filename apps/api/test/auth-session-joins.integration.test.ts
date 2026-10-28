import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {serializeSignedCookie} from 'better-call';
import {hashPassword} from 'better-auth/crypto';
import {Hono} from 'hono';
import {createAuth} from '../src/auth';
import {prepareMemberAuth,requireMember,requireAppealMember} from '../src/session';
import {authRoutes} from '../src/auth-routes';
import {persistSessionDenial} from '../src/session-denial';
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

});
