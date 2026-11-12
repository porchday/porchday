import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import {wrapRecoverySecret,splitContactRecoverySecret,combineContactRecoveryShares,recoveryDigest,sealRecoveryPayload,openRecoveryPayload,deviceBackupBinding,readRecoveryBackup} from '@porchday/crypto/recovery';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { generateDeviceKeys, unlockPrivateKey, encryptObject, decryptObject, signStatement, authorizeDevice, createReactionSecret, reactionTag, type UnlockedPrivateKey, type ContentContext } from '@porchday/crypto';
import { createSocialRoutes } from '../src/social';
import { createIntegrationConsentRoutes, createIntegrationTokenRoutes } from '../src/social-integrations';
import type { Env, Variables } from '../src/types';
import * as database from '../src/db';
import { tracingMiddleware } from '../src/tracing';
import { requestTimingMiddleware } from '../src/request-timing';
const url = process.env.KEY_RECOVERY_DATABASE_URL ?? process.env.SOCIAL_HTTP_DATABASE_URL;
const suite = url ? describe : describe.skip;
let sql: Sql;
let admin: Sql;
let databaseName: string;
let isolatedDatabaseUrl: string;
let app: Hono<{
    Bindings: Env;
    Variables: Variables;
}>;
let env: Env;
const grandfatheredId=randomUUID();
interface Person {
    id: string;
    deviceId: string;
    key: UnlockedPrivateKey;
    publicKey: string;
}
const objects = new Map<string, ArrayBuffer>();
const writing=new Set<string>();
const objectMetadata=(key:string)=>{const bytes=objects.get(key);return bytes?{key,size:bytes.byteLength,etag:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}:null;};
const memoryBucket={
 async put(key:string,body:BodyInit){if(objects.has(key)||writing.has(key))return null;writing.add(key);try{objects.set(key,await new Response(body).arrayBuffer());return objectMetadata(key);}finally{writing.delete(key);}},
 async get(key:string){const bytes=objects.get(key);return bytes?{...objectMetadata(key),body:new Response(bytes).body,arrayBuffer:async()=>bytes,json:()=>new Response(bytes).json()}:null;},
 async head(key:string){return objectMetadata(key);},
 async delete(key:string){objects.delete(key);},
};
async function request(member: string, path: string, method = 'GET', value?: unknown) { const init: RequestInit = { method, headers: { 'x-test-member': member, ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }; const response = await app.request('https://porchday.test' + path, init, env); const data = await response.json(); if (response.status >= 500)
    throw Error(JSON.stringify({ path, status: response.status, data })); return { status: response.status, data }; }
async function person() { const id = randomUUID(), deviceId = randomUUID(); await sql `insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`; await sql `insert into app.profiles(member_id,handle) values(${id},${'t_' + id.replaceAll('-', '').slice(0, 20)})`; const keys = await generateDeviceKeys(id, deviceId); const recovery = await generateDeviceKeys(id, 'recovery', keys.recoverySecret); const { status } = await request(id, '/devices', 'POST', { id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, recovery_setup_version:1, authorization: { type: 'initial' }, recovery_public_key: recovery.publicKey, backup: { v: 1, devices: [{ id: deviceId, public_key: keys.publicKey, fingerprint: keys.fingerprint, encrypted_private_key: keys.encryptedPrivateKey }], recovery: { public_key: recovery.publicKey, fingerprint: recovery.fingerprint, encrypted_private_key: recovery.encryptedPrivateKey } } }); expect(status).toBe(201); return { id, deviceId, secret:keys.recoverySecret, recoveryKey:await unlockPrivateKey(recovery.encryptedPrivateKey,keys.recoverySecret), recoveryFingerprint:recovery.fingerprint, key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret), publicKey: keys.publicKey }; }
async function connection(a: Person, b: Person, kind: 'friend' | 'family' = 'friend', history: 'full' | 'future' | null = 'future') { const [r] = await sql `select handle from app.profiles where member_id=${b.id}`; const create = await request(a.id, '/connections/requests', 'POST', { handle: r.handle, kind, ...(history ? {history} : {}) }); expect(create.status).toBe(201); expect((await request(b.id, `/connections/requests/${create.data.id}/accept`, 'POST', {kind, ...(history ? {history} : {})})).status).toBe(200); }
async function seal(a: Person, payload: unknown, override: Partial<ContentContext> = {}, postId?: string) { const audience = override.audience ?? 'connections'; const snap = await request(a.id, `/audiences?audience=${audience}${override.groupId ? '&group_id=' + override.groupId : ''}${postId ? '&post_id=' + postId : ''}`); expect(snap.status).toBe(200); const context: ContentContext = { id: randomUUID(), kind: 'post', authorId: a.id, authorDeviceId: a.deviceId, audience, parentId: null, groupId: null, epoch: snap.data.epoch, createdAt: new Date().toISOString(), expiresAt: null, revision: 1, ...override, epoch: snap.data.epoch }; return encryptObject({ context, payload, signingKey: a.key, recipients: snap.data.devices.map((d: any) => ({ memberId: d.member_id, deviceId: d.id, publicKey: d.public_key })) }); }
suite('Key recovery with real encryption and runtime RLS', () => {
    beforeAll(async () => {
        if (!url || !new URL(url).pathname.includes('test') || !['localhost','127.0.0.1'].includes(new URL(url).hostname))
            throw Error('Only disposable loopback test databases');
        const adminUrl=new URL(url);adminUrl.pathname="/postgres";
        admin=postgres(adminUrl.href,{prepare:false,max:1,onnotice:()=>{}});
        databaseName='porchday_social_http_test_'+randomUUID().replaceAll('-','');
        await admin.unsafe('CREATE DATABASE '+databaseName);
        const isolated=new URL(url);isolated.pathname='/'+databaseName;isolatedDatabaseUrl=isolated.href;
        sql=postgres(isolated.href,{prepare:false,max:4,onnotice:()=>{}});
        for (const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
            {
              if(name==='080_member_key_recovery.sql')await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${grandfatheredId},now(),now())`;
              await sql.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
            }
        await sql.unsafe('CREATE VIEW app.test_history_journal AS SELECT decision FROM app.safety_journal');
        await sql.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_http_runtime') THEN CREATE ROLE porchday_http_runtime LOGIN PASSWORD 'porchday-test-social' IN ROLE porchday_social; END IF; END $$"); const runtime = new URL(isolated); runtime.username = 'porchday_http_runtime'; runtime.password = 'porchday-test-social'; env = { KEY_RECOVERY_ENABLED:'true', HYPERDRIVE_SOCIAL: { connectionString: runtime.href }, MEDIA: memoryBucket } as unknown as Env; app = new Hono(); app.route('/integration/v1', createIntegrationTokenRoutes()); app.route('/integration', createIntegrationTokenRoutes()); app.use('*', async (c, next) => { c.set('memberId', c.req.header('x-test-member')!); c.set('authTime', Date.now()); await next(); }); app.route('/', createSocialRoutes()); app.route('/', createIntegrationConsentRoutes()); }, 30000);
    afterAll(async () => {
        if(sql)await sql.end();
        if(admin){if(databaseName)await admin.unsafe('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.end();}
    });

    const expiry=(ms=240000)=>new Date(Date.now()+ms).toISOString();
    const identity=(p:Person)=>({v:1,memberId:p.id,deviceId:p.deviceId,expiresAt:expiry()});
    async function action(p:Person,kind:string,id:string,recoveryFingerprint?:string){return signStatement({...identity(p),purpose:'porchday-recovery-action',operationId:randomUUID(),action:kind,id,...(recoveryFingerprint?{recoveryFingerprint}:{})},p.key);}
    async function passkey(p:Awaited<ReturnType<typeof person>>){const id=randomUUID(),record=await signStatement({...identity(p),purpose:'porchday-recovery-method',id,label:'Synthetic passkey',kind:'passkey',recoveryFingerprint:p.recoveryFingerprint,tested:true,passkey:{credentialId:'syntheticCredential',salt:Buffer.alloc(32,7).toString('base64'),rpId:'porchday.test',recoveryFingerprint:p.recoveryFingerprint,backupEligible:true,capsule:await wrapRecoverySecret(p.secret,new Uint8Array(32).fill(7),{id})}},p.key);return{id,record};}
    it('requires a trusted owner proof, prevents nonce replay and last-method removal, and exempts existing members',async()=>{
      const [old]=await sql`select recovery_setup_eligible,recovery_setup_required from app.members where id=${grandfatheredId}`;expect(old).toMatchObject({recovery_setup_eligible:false,recovery_setup_required:false});
      const owner=await person(),other=await person();
      await sql`update app.members set recovery_setup_required=false where id=${other.id}`;
      expect((await request(owner.id,'/key-recovery')).data.required).toBe(true);
      expect((await request(other.id,'/key-recovery')).data.required).toBe(false);
      const method=await passkey(owner);
      expect((await request(other.id,'/key-recovery/methods','POST',method.record)).status).toBe(409);
      expect((await request(owner.id,'/key-recovery/methods','POST',method.record)).status).toBe(201);
      expect((await request(other.id,'/key-recovery')).data.methods).toHaveLength(0);
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'remove',method.id))).status).toBe(409);
      const checked=await action(owner,'kit-checked',owner.id,owner.recoveryFingerprint);
      expect((await request(owner.id,'/key-recovery/actions','POST',checked)).status).toBe(200);
      expect((await request(owner.id,'/key-recovery/actions','POST',checked)).status).toBe(409);
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'complete',owner.id))).status).toBe(200);
      expect((await request(owner.id,'/key-recovery')).data.required).toBe(false);
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'remove',method.id))).status).toBe(200);
      expect((await request(owner.id,'/key-recovery/methods','POST',method.record)).status).toBe(409);
    });
    it('requires two distinct accepted contacts, encrypts responses to the new device and cancels future approvals',async()=>{
      const owner=await person(),contacts=await Promise.all([person(),person(),person()]),outsider=await person();for(const c of contacts)await connection(owner,c);
      const id=randomUUID(),shares=await splitContactRecoverySecret(owner.secret);
      const bindings=(fingerprint:string,requestId='')=>({v:1 as const,purpose:requestId?'porchday-recovery-response' as const:'porchday-recovery-share' as const,memberId:owner.id,methodId:id,requestId,recipientFingerprint:fingerprint});
      const records=await Promise.all(contacts.map(async(c,i)=>({memberId:c.id,deviceId:c.deviceId,publicKey:c.publicKey,fingerprint:c.key.getFingerprint(),shareHash:await recoveryDigest(shares[i]),ciphertext:await sealRecoveryPayload(bindings(c.key.getFingerprint()),{share:shares[i]},c.publicKey,owner.key)})));
      const method=await signStatement({...identity(owner),purpose:'porchday-recovery-method',id,label:'Trusted contacts',kind:'contacts',recoveryFingerprint:owner.recoveryFingerprint,contacts:records,tested:true},owner.key);
      expect((await request(owner.id,'/key-recovery/methods','POST',method)).status).toBe(201);
      expect((await request(outsider.id,'/key-recovery')).data.invitations).toHaveLength(0);
      for(const [i,c] of contacts.entries()){
        expect((await request(c.id,'/key-recovery')).data.invitations).toHaveLength(1);
        const opened=await openRecoveryPayload<{share:string}>(records[i].ciphertext,bindings(c.key.getFingerprint()),c.key,owner.publicKey);expect(opened.share).toBe(shares[i]);
        expect((await request(c.id,'/key-recovery/actions','POST',await action(c,'accept',id))).status).toBe(200);
      }
      const requester=await generateDeviceKeys(owner.id,randomUUID()),key=await unlockPrivateKey(requester.encryptedPrivateKey,requester.recoverySecret),requestId=randomUUID(),deviceId=randomUUID();
      const record=await signStatement({v:1,purpose:'porchday-recovery-request',id:requestId,memberId:owner.id,kind:'contacts',methodId:id,deviceId,publicKey:requester.publicKey,fingerprint:requester.fingerprint,label:'Recovered phone',expiresAt:expiry(600000)},key);
      expect((await request(owner.id,'/key-recovery/requests','POST',record)).status).toBe(201);
      expect((await request(outsider.id,'/key-recovery')).data.requests).toHaveLength(0);
      const makeResponse=async(i:number)=>signStatement({...identity(contacts[i]),purpose:'porchday-recovery-response',requestId,requestFingerprint:requester.fingerprint,methodId:id,ciphertext:await sealRecoveryPayload(bindings(requester.fingerprint,requestId),{share:shares[i]},requester.publicKey,contacts[i].key)},contacts[i].key);
      const first=await makeResponse(0);expect((await request(contacts[0].id,'/key-recovery/responses','POST',first)).status).toBe(200);
      expect((await request(contacts[0].id,'/key-recovery/responses','POST',first)).status).toBe(200);
      expect((await request(owner.id,'/key-recovery')).data.responses).toHaveLength(1);
      expect((await request(contacts[1].id,'/key-recovery/responses','POST',await makeResponse(1))).status).toBe(200);
      const rows=(await request(owner.id,'/key-recovery')).data.responses;
      const recovered=await Promise.all(rows.map(async(r:any)=>{const c=contacts.find(c=>c.id===r.member_id)!;return(await openRecoveryPayload<{share:string}>(r.record.statement.ciphertext,bindings(requester.fingerprint,requestId),key,c.publicKey)).share;}));
      expect(await combineContactRecoveryShares(recovered)).toBe(owner.secret);
      const proof=await signStatement({v:1,purpose:'porchday-recovery-finish',requestId,memberId:owner.id,cancel:true},key);
      expect((await request(owner.id,'/key-recovery/requests/'+requestId+'/finish','POST',{cancel:true,proof})).status).toBe(200);
      expect((await request(contacts[2].id,'/key-recovery/responses','POST',await makeResponse(2))).status).toBe(409);
    });
    it('pairs a fresh device without the recovery secret and keeps its key recoverable with the original kit',async()=>{
      const owner=await person(),id=randomUUID(),deviceId=randomUUID(),keys=await generateDeviceKeys(owner.id,deviceId),key=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
      const requestRecord=await signStatement({v:1,purpose:'porchday-recovery-request',id,memberId:owner.id,kind:'pair',methodId:null,deviceId,publicKey:keys.publicKey,fingerprint:keys.fingerprint,label:'Paired phone',expiresAt:expiry()},key);
      expect((await request(owner.id,'/key-recovery/requests','POST',requestRecord)).status).toBe(201);
      const challenge=(await request(owner.id,'/devices/challenge','POST',{id:deviceId,public_key:keys.publicKey,fingerprint:keys.fingerprint})).data;
      const authorization=await authorizeDevice({v:1,purpose:'porchday-device-authorization',memberId:owner.id,authorizingDeviceId:owner.deviceId,deviceId,fingerprint:keys.fingerprint,challenge:challenge.challenge,expiresAt:challenge.expires_at},owner.key);
      const binding={v:1 as const,purpose:'porchday-device-transfer' as const,memberId:owner.id,methodId:id,requestId:id,recipientFingerprint:keys.fingerprint};
      const ciphertext=await sealRecoveryPayload(binding,{armor:owner.key.armor()},keys.publicKey,owner.key);
      const approval=await signStatement({...identity(owner),purpose:'porchday-pair-approval',requestId:id,requestFingerprint:keys.fingerprint,ciphertext,authorization},owner.key);
      expect((await request(owner.id,'/key-recovery/pair-approval','POST',approval)).status).toBe(200);
      expect((await openRecoveryPayload<{armor:string}>(ciphertext,binding,key,owner.publicKey)).armor).toBe(owner.key.armor());
      const backup=(await request(owner.id,'/keys/backup')).data.envelope;
      const newEntry={id:deviceId,public_key:keys.publicKey,fingerprint:keys.fingerprint,recovery_ciphertext:await sealRecoveryPayload(deviceBackupBinding(owner.id,{id:deviceId},backup.recovery.fingerprint),key.armor(),backup.recovery.public_key,key)};
      expect((await request(owner.id,'/devices','POST',{id:deviceId,public_key:keys.publicKey,fingerprint:keys.fingerprint,authorization:{type:'trusted',signed:authorization},backup:{...backup,devices:[...backup.devices,newEntry]}})).status).toBe(201);
      const proof=await signStatement({v:1,purpose:'porchday-recovery-finish',requestId:id,memberId:owner.id,cancel:false},key);
      expect((await request(owner.id,'/key-recovery/requests/'+id+'/finish','POST',{cancel:false,proof})).status).toBe(200);
      expect((await request(owner.id,'/key-recovery/pair-approval','POST',approval)).status).toBe(409);
      const current=(await request(owner.id,'/keys/backup')).data.envelope;
      expect((await readRecoveryBackup(current,owner.secret,owner.id)).devices.map(d=>d.key.getFingerprint())).toContain(keys.fingerprint);
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'kit-checked',owner.id,owner.recoveryFingerprint))).status).toBe(200);
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'complete',owner.id))).status).toBe(200);
    });
    it('expires pairing, rejects revoked approvers, and consumes invitations only once',async()=>{
      const owner=await person(),id=randomUUID(),deviceId=randomUUID(),keys=await generateDeviceKeys(owner.id,deviceId),key=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
      const invitationId=randomUUID(),invitation=await signStatement({...identity(owner),purpose:'porchday-pair-invitation',id:invitationId,fingerprint:owner.key.getFingerprint()},owner.key);
      expect((await request(owner.id,'/key-recovery/pair-invitations','POST',invitation)).status).toBe(201);
      const statement={v:1,purpose:'porchday-recovery-request',id,memberId:owner.id,kind:'pair',methodId:null,invitationId,deviceId,publicKey:keys.publicKey,fingerprint:keys.fingerprint,label:'Expiry test',expiresAt:expiry()};
      const record=await signStatement(statement,key);
      expect((await request(owner.id,'/key-recovery/requests','POST',record)).status).toBe(201);
      expect((await request(owner.id,'/key-recovery/requests','POST',record)).status).toBe(201);
      expect((await request(owner.id,'/key-recovery/requests','POST',await signStatement({...statement,id:randomUUID()},key))).status).toBe(409);
      await sql`update app.key_recovery_requests set expires_at=now()-interval '1 second' where id=${id}`;
      expect((await request(owner.id,'/key-recovery')).data.requests).toHaveLength(0);
      expect((await request(owner.id,'/key-recovery/requests','POST',record)).status).toBe(409);
      await sql`update app.device_keys set revoked_at=now() where id=${owner.deviceId}`;
      expect((await request(owner.id,'/key-recovery/actions','POST',await action(owner,'dismiss',owner.id))).status).toBe(409);
    });
    it.each(['chromium','webkit'] as const)('%s pairs through the actual mobile UI and decrypts old content without entering the recovery secret',async engine=>{
      const owner=await person();await sql`update app.members set recovery_setup_required=false where id=${owner.id}`;
      const member=(await request(owner.id,'/me')).data,roster=(await request(owner.id,'/devices')).data.items;
      const context:ContentContext={id:randomUUID(),kind:'post',authorId:owner.id,authorDeviceId:owner.deviceId,audience:'only_me',parentId:null,groupId:null,epoch:1,createdAt:new Date().toISOString(),expiresAt:null,revision:1};
      const envelope=await encryptObject({context,payload:{text:'history recovered through pairing'},signingKey:owner.key,recipients:[{memberId:owner.id,deviceId:owner.deviceId,publicKey:owner.publicKey}]});
      const fixture={member,device:roster.find((d:any)=>d.id===owner.deviceId),armor:owner.key.armor(),envelope};
      const bundle=await build({stdin:{contents:`
        import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
        import {RecoveryManager} from './apps/web/src/RecoveryManager';import {VaultProvider,useVault} from './apps/web/src/vault';
        import {importRecoveryPrivateKey} from '@porchday/crypto/recovery';
        const f=window.fixture;
        function History(){const vault=useVault(),[text,setText]=useState('');useEffect(()=>{vault.open({envelope:f.envelope}).then(value=>setText(value.text));},[]);return <p>{text}</p>;}
        const root=createRoot(document.getElementById('root'));
        if(location.pathname==='/owner'){const key=await importRecoveryPrivateKey(f.armor,f.device.fingerprint);root.render(<RecoveryManager actor={{member:f.member,device:f.device,privateKey:key,keys:[key]}}/>);}
        else root.render(<VaultProvider member={f.member} onAccountDeleted={async()=>{}}><History/></VaultProvider>);
      `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',write:false,define:{'process.env.NODE_ENV':'"production"'}});
      const inflight=new Set<Promise<void>>(),serverErrors:unknown[]=[];let interruptEnrollment=engine==='webkit';
      const server=createServer((req,res)=>{
        const work=(async()=>{
          const url=new URL(req.url!,'http://localhost'),path=url.pathname;
          if(path==='/module.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
          if(path.startsWith('/api/v1/')){
            const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
            const response=await app.request('https://porchday.test'+path.replace('/api/v1','')+url.search,{method:req.method,headers:{'x-test-member':owner.id,'content-type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks).toString()}:{})},env);
            if(interruptEnrollment&&path==='/api/v1/devices'&&req.method==='POST'&&response.status===201){interruptEnrollment=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_INTERRUPTED_RESPONSE'}}));return;}
            res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());return;
          }
          res.setHeader('content-type','text/html');res.end('<main><div id="root"></div></main><script>window.fixture='+JSON.stringify(path==='/owner'?fixture:{member,envelope}).replaceAll('<','\\u003c')+'</script><script type="module" src="/module.js"></script>');
        })().catch(error=>{serverErrors.push(error);if(!res.writableEnded){res.statusCode=500;res.end();}});
        inflight.add(work);void work.finally(()=>inflight.delete(work));
      });
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
      const browser=await(engine==='chromium'?chromium:webkit).launch();try{
        const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:390,height:844}})]);
        const trusted=await contexts[0].newPage(),phone=await contexts[1].newPage();await trusted.goto(origin+'/owner');await phone.goto(origin+'/phone');
        await phone.getByLabel(/This is my private device/).check();
        if(engine==='chromium'){
          await trusted.getByRole('button',{name:'Show a QR code for my other device to scan'}).click();
          const code=await trusted.locator('code').filter({hasText:'porchday-invite:'}).textContent();expect(code).toBeTruthy();
          await phone.getByText('Scan a code displayed on my trusted device',{exact:true}).click();await phone.getByLabel('Or paste pairing code').fill(code!);await phone.getByRole('button',{name:'Use pairing code',exact:true}).click();
          await trusted.getByRole('button',{name:/Review pairing request from/}).click({timeout:20000});
        }else{
          await phone.getByRole('button',{name:'Use another trusted device',exact:true}).click();
          const code=await phone.locator('code').filter({hasText:'porchday-pair:'}).textContent();expect(code).toBeTruthy();
          const image=phone.getByRole('img',{name:'Scan this Porchday pairing code on your other device'});await image.waitFor();const data=await image.getAttribute('src');await trusted.getByLabel('Or choose a QR code picture').setInputFiles({name:'pair.png',mimeType:'image/png',buffer:Buffer.from(data!.split(',')[1],'base64')});
        }
        await trusted.getByLabel(/I compared this full fingerprint/).check();await trusted.getByRole('button',{name:'Approve encrypted transfer'}).click();
        await phone.getByRole('button',{name:'Verify transfer and unlock'}).click({timeout:20000});
        if(engine==='webkit'){await expect.poll(()=>phone.getByRole('button',{name:'Verify transfer and unlock'}).isEnabled()).toBe(true);await phone.getByRole('button',{name:'Verify transfer and unlock'}).click();}
        await phone.getByText('history recovered through pairing',{exact:true}).waitFor({timeout:20000});
        const backup=(await request(owner.id,'/keys/backup')).data.envelope;expect((await readRecoveryBackup(backup,owner.secret,owner.id)).devices).toHaveLength(2);
        await phone.reload();await phone.getByText('history recovered through pairing',{exact:true}).waitFor({timeout:20000});
        if(engine==='chromium'){
          const third=await browser.newContext(),page=await third.newPage();await page.goto(origin+'/phone');await page.getByLabel(/This is my private device/).check();await page.getByRole('button',{name:'Use another trusted device',exact:true}).click();
          const code=await page.locator('code').filter({hasText:'porchday-pair:'}).textContent();await trusted.getByLabel('Or paste pairing code').fill(code!);await trusted.getByRole('button',{name:'Use pairing code',exact:true}).click();await trusted.getByLabel(/I compared this full fingerprint/).check();await trusted.getByRole('button',{name:'Approve encrypted transfer'}).click();await page.getByRole('button',{name:'Verify transfer and unlock'}).click({timeout:20000});await page.getByText('history recovered through pairing',{exact:true}).waitFor({timeout:20000});
          const complete=(await request(owner.id,'/keys/backup')).data.envelope;expect((await readRecoveryBackup(complete,owner.secret,owner.id)).devices).toHaveLength(3);
        }

      }finally{await browser.close();await Promise.all([...inflight]);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}expect(serverErrors).toEqual([]);
    },60000);

});
