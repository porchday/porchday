import {test,expect} from 'vitest';
import {SignJWT,generateKeyPair,exportJWK,createLocalJWKSet} from 'jose';
import {Hono} from 'hono';
import {verifyStaffAssertion,requireStaff} from '../src/staff';
import type {Env,Variables} from '../src/types';

test('staff assertions reject wrong issuer, audience, expired or forged tokens and machine identities',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwk=await exportJWK(publicKey);const keys=createLocalJWKSet({keys:[{...jwk,kid:'synthetic'}]});
 const issuer='https://synthetic.cloudflareaccess.com',audience='staff-only';
 const token=(claims:Record<string,unknown>={})=>new SignJWT({email:'reviewer@example.test',type:'app',...claims}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setSubject('reviewer-1').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 expect(await verifyStaffAssertion(await token(),issuer,audience,keys)).toEqual({subject:'reviewer-1',email:'reviewer@example.test'});
 await expect(verifyStaffAssertion(await token(),issuer,'wrong-audience',keys)).rejects.toThrow();
 await expect(verifyStaffAssertion(await token(),'https://wrong.cloudflareaccess.com',audience,keys)).rejects.toThrow();
 await expect(verifyStaffAssertion(await token({type:'service'}),issuer,audience,keys)).rejects.toThrow();
 await expect(verifyStaffAssertion(await token({email:''}),issuer,audience,keys)).rejects.toThrow();
 const emptySubject=await new SignJWT({email:'reviewer@example.test',type:'app'}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setSubject('').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 await expect(verifyStaffAssertion(emptySubject,issuer,audience,keys)).rejects.toThrow();
 const expired=await new SignJWT({email:'reviewer@example.test',type:'app'}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setSubject('reviewer-1').setIssuer(issuer).setAudience(audience).setIssuedAt(Math.floor(Date.now()/1000)-7200).setExpirationTime(Math.floor(Date.now()/1000)-3600).sign(privateKey);
 await expect(verifyStaffAssertion(expired,issuer,audience,keys)).rejects.toThrow();
 const forged=(await token()).split('.');forged[1]=btoa(JSON.stringify({sub:'admin',email:'reviewer@example.test',type:'app',iss:issuer,aud:audience,exp:9999999999}));
 await expect(verifyStaffAssertion(forged.join('.'),issuer,audience,keys)).rejects.toThrow();
});
test('staff origin denies access when configuration or assertion is absent',async()=>{
 const app=new Hono<{Bindings:Env;Variables:Variables}>();app.use('*',requireStaff('recovery'));app.get('/',c=>c.json({ok:true}));
 expect((await app.request('/',undefined,{} as Env)).status).toBe(503);
 expect((await app.request('/',undefined,{STAFF_ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',STAFF_ACCESS_AUDIENCE:'staff'} as Env)).status).toBe(401);
});
