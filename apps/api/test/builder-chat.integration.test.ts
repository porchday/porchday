import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {execFileSync} from 'node:child_process';
import {serializeSignedCookie} from 'better-call';
import {app} from '../src/index';
import {BUILDER_CHAT,bridgeTokenMatches} from '../src/builder-chat';
import type {Env} from '../src/types';

const base=process.env.TEST_DATABASE_URL,suite=base?describe:describe.skip;
const suffix=randomUUID().replaceAll('-',''),database='porchday_builder_'+suffix;
const roles={auth:'porchday_builder_auth_'+suffix,social:'porchday_builder_social_'+suffix,jobs:'porchday_builder_jobs_'+suffix};
const token='synthetic-bridge-token-'+'x'.repeat(40);
let admin:Pool,owner:Pool,env:Env,ownerUrl='';
type Person={id:string;handle:string;cookie:string};
async function person():Promise<Person>{
 const id=randomUUID(),handle='b_'+id.replaceAll('-','').slice(0,16),session=randomUUID(),value=randomUUID();
 await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,handle,id+'@example.test']);
 await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,handle]);
 await owner.query('INSERT INTO public.auth_session(id,"expiresAt",token,"userId") VALUES($1,now()+interval\'7 days\',$2,$3)',[session,value,id]);
 return {id,handle,cookie:(await serializeSignedCookie('better-auth.session_token',value,env.BETTER_AUTH_SECRET)).split(';')[0]};
}
async function call(method:string,path:string,{cookie='',body,overrides={},headers={}}:{cookie?:string;body?:unknown;overrides?:Partial<Env>;headers?:Record<string,string>}={}){
 const pending:Promise<unknown>[]=[];
 const response=await app.fetch(new Request(env.APP_URL+path,{method,headers:{Origin:env.APP_URL,Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),{...env,...overrides},{waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext);
 await Promise.all(pending);
 return response;
}
const member=(p:Person,method:string,path:string,body?:unknown,overrides:Partial<Env>={})=>call(method,'/api/v1/builder-chat'+path,{cookie:p.cookie,body,overrides});
const bridge=(path:string,body:unknown={},overrides:Partial<Env>={},auth='Bearer '+token)=>call('POST','/api/builder-bridge'+path,{body,overrides,headers:{Authorization:auth,Origin:''}});
async function allow(p:Person,accept=true){
 await owner.query("INSERT INTO app.builder_chat_access(member_id,enabled_by) VALUES($1,'test-operator')",[p.id]);
 if(accept)expect((await member(p,'POST','/disclosure',{version:BUILDER_CHAT.disclosureVersion})).status).toBe(200);
}
const send=(p:Person,message='Please add a footer link.',overrides:Partial<Env>={})=>member(p,'POST','/messages',{message},overrides);
const claim=async(overrides:Partial<Env>={},take=true)=>(await (await bridge('/claim',{take},overrides)).json()).message;
async function clearQueue(){await owner.query("UPDATE app.builder_chat_messages SET status='answered',completed_at=now() WHERE status IN('queued','working')");}

suite('builder chat through real sessions and restricted SQL roles',()=>{
 beforeAll(async()=>{
  const url=new URL(base!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Disposable loopback database required');
  url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});
  await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;ownerUrl=url.href;owner=new Pool({connectionString:url.href,max:2});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await owner.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const connection=(role:string)=>{const u=new URL(url.href);u.username=role;u.password='synthetic-builder-test';return {connectionString:u.href};};
  for(const [kind,role] of Object.entries(roles))await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-builder-test' IN ROLE porchday_${kind}`);
  env={APP_URL:'http://localhost:8787',ENVIRONMENT:'development',BETTER_AUTH_SECRET:'synthetic-builder-key-longer-than-thirty-two-characters',EMAIL_FROM:'accounts@example.test',
   BUILDER_CHAT_PAUSED:'false',BUILDER_BRIDGE_TOKEN:token,
   HYPERDRIVE_AUTH:connection(roles.auth),HYPERDRIVE_SOCIAL:connection(roles.social),HYPERDRIVE_JOBS:connection(roles.jobs)} as unknown as Env;
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Unexpected test network');});
 },30000);
 afterAll(async()=>{
  vi.restoreAllMocks();if(owner)await owner.end();
  if(admin)try{
   for(let i=0;i<200;i++){if((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n===0)break;await new Promise(r=>setTimeout(r,25));}
   await admin.query('DROP DATABASE IF EXISTS '+database);
   for(const role of Object.values(roles))await admin.query('DROP ROLE IF EXISTS '+role);
  }finally{await admin.end();}
 });

 it('exposes fixed queue activity, clears stale labels, and never includes another member’s message',async()=>{
  await clearQueue();
  const first=await person(),second=await person();await allow(first);await allow(second);
  await send(first,'Private first request');await send(second,'My queued request');
  expect((await bridge('/claim',{take:false,waiting_on:'request_file'})).status).toBe(200);
  let value=await (await member(second,'GET','')).json();
  expect(value.activity).toBe('request_file');expect(value.ahead).toBe(1);
  expect(JSON.stringify(value)).not.toContain('Private first request');
  expect((await bridge('/claim',{take:false,waiting_on:'/private/lock-owner'})).status).toBe(400);
  await owner.query("UPDATE app.builder_chat_bridge SET seen_at=now()-interval '1 minute'");
  value=await (await member(second,'GET','')).json();expect(value.activity).toBe('offline');
  await claim();
  value=await (await member(second,'GET','')).json();expect(value.activity).toBe('chat');
  await clearQueue();await claim();
  value=await (await member(second,'GET','')).json();expect(value.activity).toBe('idle');
  // Old bridge payloads remain accepted during a rolling installation.
  expect((await bridge('/claim',{take:false})).status).toBe(200);
  value=await (await member(second,'GET','')).json();expect(value.activity).toBe('other_work');
 });

 it('hides builder chat from members who are not on the allowlist, even while paused',async()=>{
  const outsider=await person();
  for(const overrides of [{},{BUILDER_CHAT_PAUSED:'true'}]){
   expect((await member(outsider,'GET','',undefined,overrides)).status).toBe(404);
   expect((await send(outsider,'hello',overrides)).status).toBe(404);
   expect((await member(outsider,'POST','/disclosure',{version:1},overrides)).status).toBe(404);
   expect((await member(outsider,'GET','/export',undefined,overrides)).status).toBe(404);
  }
  expect((await call('GET','/api/v1/builder-chat')).status).toBe(401);
 });

 it('requires the current disclosure and refuses messages during a pause',async()=>{
  const p=await person();await allow(p,false);
  const first=await (await member(p,'GET','')).json();
  expect(first.disclosure).toEqual({version:BUILDER_CHAT.disclosureVersion,accepted:false});
  expect((await send(p)).status).toBe(409);
  expect((await member(p,'POST','/disclosure',{version:BUILDER_CHAT.disclosureVersion+1})).status).toBe(400);
  expect((await member(p,'POST','/disclosure',{version:BUILDER_CHAT.disclosureVersion})).status).toBe(200);
  expect((await member(p,'GET','')).status).toBe(200);
  const paused=await send(p,'hello',{BUILDER_CHAT_PAUSED:'true'});
  expect(paused.status).toBe(503);expect((await paused.json()).error.code).toBe('BUILDER_CHAT_PAUSED');
  // A missing setting is treated as paused.
  expect((await send(p,'hello',{BUILDER_CHAT_PAUSED:undefined})).status).toBe(503);
  expect((await (await member(p,'GET','',undefined,{BUILDER_CHAT_PAUSED:'true'})).json()).paused).toBe(true);
  expect((await claim({BUILDER_CHAT_PAUSED:'true'}))).toBeNull();
 });

 it('enforces the length limit, one message in flight and the daily limit',async()=>{
  await clearQueue();
  const p=await person();await allow(p);
  expect((await send(p,'x'.repeat(BUILDER_CHAT.messageLength+1))).status).toBe(400);
  expect((await send(p,'   ')).status).toBe(400);
  expect((await send(p,'x'.repeat(BUILDER_CHAT.messageLength))).status).toBe(201);
  const second=await send(p,'another');
  expect(second.status).toBe(409);expect((await second.json()).error.code).toBe('IN_FLIGHT');
  await clearQueue();
  await owner.query('INSERT INTO app.builder_chat_messages(member_id,body,status) SELECT $1,$2,$3 FROM generate_series(1,$4)',[p.id,'old','answered',98]);
  expect((await (await member(p,'GET','')).json()).limits.daily_messages).toBe(100);
  expect((await send(p,'message 100')).status).toBe(201);
  await clearQueue();
  const limited=await send(p,'one too many');
  expect(limited.status).toBe(429);expect((await limited.json()).error).toEqual({code:'DAILY_LIMIT',message:'You can send up to 100 builder chat messages a day. Please try again tomorrow.'});
 });

 it('limits the shared queue',async()=>{
  await clearQueue();
  const filler=await person();await allow(filler);
  await owner.query("INSERT INTO app.builder_chat_messages(member_id,body,created_at) SELECT $1,'queued',now()-interval '2 days' FROM generate_series(1,$2)",[filler.id,BUILDER_CHAT.queueLength]);
  const p=await person();await allow(p);
  const full=await send(p);
  expect(full.status).toBe(429);expect((await full.json()).error.code).toBe('QUEUE_FULL');
  await clearQueue();
 });

 it('serves the queue in order and streams progress only to the sender',async()=>{
  await clearQueue();
  const a=await person(),b=await person();await allow(a);await allow(b);
  const aId=(await (await send(a,'first')).json()).id;
  const bId=(await (await send(b,'second')).json()).id;
  expect((await (await member(b,'GET','')).json()).ahead).toBe(1);
  expect((await bridge('/claim',{take:true},{},'Bearer wrong-token-'+'y'.repeat(40))).status).toBe(401);
  expect((await bridge('/claim',{take:true},{BUILDER_BRIDGE_TOKEN:undefined})).status).toBe(404);
  expect((await bridge('/claim',{take:true},{},'')).status).toBe(401);
  // A heartbeat never takes a message.
  expect(await claim({},false)).toBeNull();
  const first=await claim();
  expect(first).toMatchObject({id:aId,handle:a.handle,body:'first'});
  // Only one turn runs at a time.
  expect(await claim()).toBeNull();
  const progress=await bridge(`/messages/${aId}/progress`,{reply:'Working on the footer',progress:'editing'});
  expect(await progress.json()).toEqual({continue:true});
  const aView=await (await member(a,'GET','')).json(),bView=await (await member(b,'GET','')).json();
  expect(aView.online).toBe(true);
  expect(aView.messages.at(-1)).toMatchObject({id:aId,status:'working',progress:'editing',reply:'Working on the footer'});
  expect(JSON.stringify(bView)).not.toContain('Working on the footer');
  expect(bView.messages.map((m:{id:string})=>m.id)).toEqual([bId]);
  const finished=await bridge(`/messages/${aId}/finish`,{status:'answered',reply:'Done.',commits:['4c7ef31'],held_back:['github_token']});
  expect(await finished.json()).toEqual({recorded:true});
  expect((await (await member(a,'GET','')).json()).messages.at(-1)).toMatchObject({status:'answered',reply:'Done.',commits:['4c7ef31'],progress:null});
  const audit=await owner.query('SELECT event,detail FROM app.builder_chat_audit WHERE message_id=$1 ORDER BY id',[aId]);
  expect(audit.rows.map(r=>r.event)).toEqual(['claimed','answered','held_back']);
  expect(JSON.stringify(audit.rows)).not.toContain('Done.');
  expect((await claim()).id).toBe(bId);
  expect((await bridge(`/messages/${bId}/finish`,{status:'answered',reply:'x',commits:['not a hash'],held_back:[]})).status).toBe(400);
  await clearQueue();
 });

 it('times out a turn left behind by a stopped bridge and stops a turn when access is removed',async()=>{
  await clearQueue();
  const a=await person(),b=await person();await allow(a);await allow(b);
  const aId=(await (await send(a,'slow')).json()).id;
  expect((await claim()).id).toBe(aId);
  await owner.query("UPDATE app.builder_chat_messages SET started_at=now()-make_interval(secs=>$2) WHERE id=$1",[aId,BUILDER_CHAT.turnSeconds+121]);
  const bId=(await (await send(b,'next')).json()).id;
  expect((await claim()).id).toBe(bId);
  expect((await (await member(a,'GET','')).json()).messages.at(-1).status).toBe('timed_out');
  await owner.query('DELETE FROM app.builder_chat_access WHERE member_id=$1',[b.id]);
  expect(await (await bridge(`/messages/${bId}/progress`,{reply:'partial',progress:'working'})).json()).toEqual({continue:false});
  expect((await member(b,'GET','')).status).toBe(404);
  // Commits made before the stop are still recorded for rollback.
  await bridge(`/messages/${bId}/finish`,{status:'answered',reply:'late',commits:['abc1234'],held_back:[]});
  const [row]=(await owner.query('SELECT status,commits FROM app.builder_chat_messages WHERE id=$1',[bId])).rows;
  expect(row).toEqual({status:'failed',commits:['abc1234']});
  // A pause stops new turns but lets the running turn finish.
  const c=await person();await allow(c);
  const cId=(await (await send(c,'during pause')).json()).id;
  expect((await claim()).id).toBe(cId);
  expect(await (await bridge(`/messages/${cId}/progress`,{reply:'x',progress:null},{BUILDER_CHAT_PAUSED:'true'})).json()).toEqual({continue:true});
  await clearQueue();
 });

 it('exports the member’s own messages and deletes them with the account',async()=>{
  await clearQueue();
  const p=await person(),other=await person();await allow(p);await allow(other);
  await send(p,'export me');await clearQueue();await send(other,'not yours');await clearQueue();
  const exported=await member(p,'GET','/export');
  expect(exported.headers.get('Content-Disposition')).toContain('attachment');
  const value=await exported.json();
  expect(value.messages.map((m:{message:string})=>m.message)).toEqual(['export me']);
  await owner.query("SELECT set_config('app.member_id',$1,false)",[p.id]);
  await owner.query('SELECT app.delete_member()');
  await owner.query("SELECT set_config('app.member_id','',false)");
  for(const table of ['builder_chat_access','builder_chat_messages','builder_chat_audit'])
   expect((await owner.query(`SELECT count(*)::int AS n FROM app.${table} WHERE member_id=$1`,[p.id])).rows[0].n).toBe(0);
  expect((await owner.query('SELECT count(*)::int AS n FROM app.builder_chat_messages WHERE member_id=$1',[other.id])).rows[0].n).toBe(1);
 });

 it('adds and removes members with the operator command and cancels a removed member’s queued message',async()=>{
  await clearQueue();
  const p=await person();
  const access=(...args:string[])=>execFileSync(process.execPath,[new URL('../../../scripts/builder-chat-access.ts',import.meta.url).pathname,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,DATABASE_MIGRATION_URL:ownerUrl,PG_LOCAL:'true',OPERATOR:'test-operator'}});
  expect(access('add','@'+p.handle)).toContain('Added @'+p.handle);
  expect(access('add',p.handle)).toContain('already on the allowlist');
  expect(access('list')).toContain('@'+p.handle+'  added by test-operator');
  expect((await member(p,'POST','/disclosure',{version:BUILDER_CHAT.disclosureVersion})).status).toBe(200);
  const id=(await (await send(p)).json()).id;
  expect(access('remove',p.handle)).toContain('Removed @'+p.handle);
  expect((await member(p,'GET','')).status).toBe(404);
  expect((await owner.query('SELECT status FROM app.builder_chat_messages WHERE id=$1',[id])).rows[0].status).toBe('failed');
  expect(await claim()).toBeNull();
  const events=(await owner.query('SELECT event,detail FROM app.builder_chat_audit WHERE member_id=$1 ORDER BY id',[p.id])).rows;
  expect(events.map(e=>e.event)).toEqual(['access_added','disclosure_accepted','access_removed']);
  expect(()=>access('add','nobody_here')).toThrow();
 });

 it('answers 404 rather than 503 when the API is deployed before migration 050',async()=>{
  const p=await person();
  await owner.query('ALTER FUNCTION app.builder_chat_state() RENAME TO builder_chat_state_hidden');
  try{expect((await member(p,'GET','')).status).toBe(404);}
  finally{await owner.query('ALTER FUNCTION app.builder_chat_state_hidden() RENAME TO builder_chat_state');}
 });

 it('limits table access to the definer functions and the staff view to the builder_chat role',async()=>{
  const social=new Pool({...env.HYPERDRIVE_SOCIAL,max:1}),auth=new Pool({...env.HYPERDRIVE_AUTH,max:1}),jobs=new Pool({...env.HYPERDRIVE_JOBS,max:1});
  try{
   for(const pool of [social,auth,jobs])await expect(pool.query('SELECT * FROM app.builder_chat_messages')).rejects.toThrow(/permission denied/);
   await expect(social.query('SELECT app.builder_chat_claim(600,true)')).rejects.toThrow(/permission denied/);
   await expect(jobs.query('SELECT app.builder_chat_state()')).rejects.toThrow(/permission denied/);
   await owner.query("INSERT INTO public.staff_users(subject,email,active,roles) VALUES('staff-mod','mod@example.test',true,'{moderation}'),('staff-builder','builder@example.test',true,'{builder_chat}')");
   await expect(auth.query("SELECT app.builder_chat_staff_view('staff-mod')")).rejects.toThrow(/STAFF_FORBIDDEN/);
   const view=(await auth.query("SELECT app.builder_chat_staff_view('staff-builder') AS v")).rows[0].v;
   expect(view).toHaveProperty('messages');expect(view).toHaveProperty('audit');expect(view).toHaveProperty('access');
   await expect(owner.query("INSERT INTO public.staff_users(subject,email,active,roles) VALUES('staff-bad','bad@example.test',true,'{superuser}')")).rejects.toThrow(/staff_roles_allowed/);
  }finally{await Promise.all([social.end(),auth.end(),jobs.end()]);}
 });
});

describe('bridge token comparison',()=>{
 it('accepts only the exact configured token of a safe length',async()=>{
  expect(await bridgeTokenMatches(token,token)).toBe(true);
  expect(await bridgeTokenMatches(token+'x',token)).toBe(false);
  expect(await bridgeTokenMatches('',token)).toBe(false);
  expect(await bridgeTokenMatches('short','short')).toBe(false);
  expect(await bridgeTokenMatches(token,undefined)).toBe(false);
 });
});
