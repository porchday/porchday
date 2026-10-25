/** Exercise the actual local Workers runtime, not Hono's in-process test adapter. */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {hashPassword} from 'better-auth/crypto';

const base=process.env.WORKER_SMOKE_URL||'http://localhost:8788';
const database=process.env.TEST_DATABASE_URL;
if(!database)throw new Error('TEST_DATABASE_URL is required for a disposable local fixture.');
for(const value of [base,database])if(!['localhost','127.0.0.1'].includes(new URL(value).hostname))throw new Error('This smoke test is restricted to local services.');
const owner=new Pool({connectionString:database}),id=crypto.randomUUID();
const email='workerd-'+id+'@example.test',handle='worker_'+id.replaceAll('-','').slice(0,16);
const password='synthetic-workerd-password-'+crypto.randomUUID();
const started=performance.now();
try{
 await owner.query('INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[id,handle,email]);
 await owner.query('SELECT app.auth_provision_member($1::uuid,$2)',[id,handle]);
 await owner.query(`INSERT INTO public.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,[crypto.randomUUID(),id,await hashPassword(password)]);
 const home=await fetch(base);
 assert.equal(home.status,200,'Worker must serve the built public app');
 assert.match(home.headers.get('content-security-policy')||'',/default-src 'self'/);
 const denied=await fetch(base+'/api/v1/me');
 assert.equal(denied.status,401);
 assert.match(denied.headers.get('cache-control')||'',/no-store/);
 const login=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
 assert.equal(login.status,200,'Password sign-in must execute successfully inside workerd');
 const cookies=login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
 assert.ok(cookies,'Successful sign-in must issue a session cookie');
 const me=await fetch(base+'/api/v1/me',{headers:{Cookie:cookies}});
 assert.equal(me.status,200);
 assert.equal((await me.json() as {id:string}).id,id);
 const logout=await fetch(base+'/api/auth/sign-out',{method:'POST',headers:{Origin:base,Cookie:cookies,'Content-Type':'application/json'},body:'{}'});
 assert.equal(logout.status,200);
 assert.equal((await fetch(base+'/api/v1/me',{headers:{Cookie:cookies}})).status,401,'Server-side revocation must reject the old cookie');
 console.log('Local workerd: static/CSP, private-route denial, password hashing/sign-in, authenticated member lookup, and logout/revocation passed ('+Math.round(performance.now()-started)+'ms).');
}finally{
 await owner.query('DELETE FROM public.auth_user WHERE id=$1',[id]);
 await owner.query('DELETE FROM app.members WHERE id=$1',[id]);
 await owner.end();
}
