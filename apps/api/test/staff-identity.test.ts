import {test,expect,vi,afterEach} from 'vitest';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';
import {Hono} from 'hono';
import {requireStaffIdentity,requireStaff} from '../src/staff';
import type {Env,Variables} from '../src/types';

const db=vi.hoisted(()=>({query:vi.fn(),end:vi.fn(async()=>{})}));
vi.mock('../src/auth',()=>({authPool:()=>db}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

test('verified staff can identify themselves without member keys, but cannot grant themselves any role',async()=>{
 const issuer='https://enrollment-test.cloudflareaccess.com',audience='staging-staff';
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwk={...await exportJWK(publicKey),kid:'enrollment'};
 const fetchKey=vi.fn(async(url:URL)=>{
  expect(String(url)).toBe(issuer+'/cdn-cgi/access/certs');
  return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
 });
 vi.stubGlobal('fetch',fetchKey);
 const assertion=await new SignJWT({email:'Reviewer@example.test',type:'app'}).setProtectedHeader({alg:'RS256',kid:'enrollment'}).setSubject('real-provider-subject').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.get('/identity',requireStaffIdentity,c=>c.json({subject:c.get('staffSubject'),email:c.get('staffEmail'),roles:c.get('staffRoles')}));
 app.get('/recovery',requireStaff('recovery'),c=>c.json({ok:true}));
 app.get('/moderation',requireStaff('moderation'),c=>c.json({ok:true}));
 const env={STAFF_ACCESS_ISSUER:issuer,STAFF_ACCESS_AUDIENCE:audience} as Env;
 const context={waitUntil:vi.fn(),passThroughOnException:vi.fn(),props:{}} as unknown as ExecutionContext;
 const call=(path:string,token=assertion)=>app.fetch(new Request('https://staff.example.test'+path,{headers:{'Cf-Access-Jwt-Assertion':token}}),env,context);
 db.query.mockResolvedValue({rows:[]});
 const identity=await call('/identity');
 expect(identity.status).toBe(200);
 expect(await identity.json()).toEqual({subject:'real-provider-subject',email:'reviewer@example.test',roles:[]});
 expect(db.query).toHaveBeenCalledWith('SELECT roles FROM public.staff_users WHERE subject=$1 AND lower(email)=$2 AND active',['real-provider-subject','reviewer@example.test']);
 expect((await call('/recovery')).status).toBe(403);
 expect((await call('/moderation')).status).toBe(403);
 db.query.mockResolvedValue({rows:[{roles:['recovery']}]});
 expect((await call('/recovery')).status).toBe(200);
 expect((await call('/moderation')).status).toBe(403);
 expect(await (await call('/identity')).json()).toEqual({subject:'real-provider-subject',email:'reviewer@example.test',roles:['recovery']});
 // A revoked or mismatched subject/email pair is absent from the exact active lookup.
 db.query.mockResolvedValue({rows:[]});
 expect((await call('/recovery')).status).toBe(403);
 const priorQueries=db.query.mock.calls.length;
 const forged=assertion.split('.');
 forged[1]=Buffer.from(JSON.stringify({sub:'another-person',email:'reviewer@example.test',type:'app',iss:issuer,aud:audience,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
 expect((await call('/identity',forged.join('.'))).status).toBe(401);
 expect(db.query.mock.calls.length).toBe(priorQueries);
 expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT roles FROM public.staff_users'))).toBe(true);
 expect(fetchKey).toHaveBeenCalledTimes(1);
});
