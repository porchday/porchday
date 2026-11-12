import type {Hono,Context} from 'hono';
import {z} from 'zod';
import {fingerprint,verifyStatement,canonicalJson} from '@porchday/crypto';
import {withMember,type Db} from './db';
import type {Env,Variables} from './types';
export class KeyRecoveryError extends Error {}
type C=Context<{Bindings:Env;Variables:Variables}>;
const uuid=z.string().uuid(),fp=z.string().regex(/^[a-f0-9]{64}$/),armor=z.string().max(30000),signature=z.string().max(10000),cipher=z.string().startsWith('-----BEGIN PGP MESSAGE-----').max(2000000),b64=z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const identity={v:z.literal(1),memberId:uuid,deviceId:uuid,expiresAt:z.string().datetime({offset:true})};
const contact=z.object({memberId:uuid,deviceId:uuid,publicKey:armor,fingerprint:fp,shareHash:fp,ciphertext:cipher.max(45000)}).strict();
const passkey=z.object({credentialId:z.string().regex(/^[A-Za-z0-9_-]+$/).max(2048),salt:b64.length(44),rpId:z.string().max(255),recoveryFingerprint:fp,backupEligible:z.boolean(),capsule:z.object({v:z.literal(1),iv:b64.length(16),ciphertext:b64.length(80)}).strict()}).strict();
const methodStatement=z.object({...identity,purpose:z.literal('porchday-recovery-method'),id:uuid,label:z.string().trim().min(1).max(80),kind:z.enum(['passkey','contacts']),recoveryFingerprint:fp,passkey:passkey.optional(),contacts:z.array(contact).length(3).optional(),tested:z.literal(true)}).strict().refine(x=>x.kind==='passkey'?!!x.passkey&&!x.contacts:!!x.contacts&&!x.passkey);
const signedMethod=z.object({statement:methodStatement,signature}).strict();
const actionStatement=z.object({...identity,purpose:z.literal('porchday-recovery-action'),action:z.enum(['remove','accept','decline','kit-checked','dismiss','complete']),operationId:uuid,id:uuid,recoveryFingerprint:fp.optional()}).strict();
const signedAction=z.object({statement:actionStatement,signature}).strict();
const requestStatement=z.object({v:z.literal(1),purpose:z.literal('porchday-recovery-request'),id:uuid,memberId:uuid,kind:z.enum(['pair','contacts']),methodId:uuid.nullable(),invitationId:uuid.optional(),deviceId:uuid,publicKey:armor,fingerprint:fp,label:z.string().trim().min(1).max(80),expiresAt:z.string().datetime({offset:true})}).strict();
const signedRequest=z.object({statement:requestStatement,signature}).strict();
const responseStatement=z.object({...identity,purpose:z.literal('porchday-recovery-response'),requestId:uuid,requestFingerprint:fp,methodId:uuid,ciphertext:cipher.max(45000)}).strict();
const signedResponse=z.object({statement:responseStatement,signature}).strict();
const pairingStatement=z.object({...identity,purpose:z.literal('porchday-pair-approval'),requestId:uuid,requestFingerprint:fp,ciphertext:cipher,authorization:z.any()}).strict();
const signedPairing=z.object({statement:pairingStatement,signature}).strict();
function error(c:C,code:string,status:400|403|404|409=400){return c.json({error:{code}},status);}
async function body<T>(c:C,schema:z.ZodType<T>,limit=2200000){const raw=await c.req.text();if(new TextEncoder().encode(raw).length>limit)throw new KeyRecoveryError('Recovery input too large');return schema.parse(JSON.parse(raw));}
function tx<T>(c:C,fn:(db:Db)=>Promise<T>){return withMember(c.env,c.get('memberId'),fn);}
function fresh(expires:string,maximum=300000){const t=Date.parse(expires);return Number.isFinite(t)&&t>Date.now()&&t<=Date.now()+maximum;}
async function author(db:Db,record:any,member:string){const s=record.statement;if(s.memberId!==member||!fresh(s.expiresAt))throw new KeyRecoveryError('Invalid recovery proof');const[key]=await db`select public_key from app.device_keys where member_id=${member} and id=${s.deviceId} and revoked_at is null for share`;if(!key)throw new KeyRecoveryError('Invalid recovery author');await verifyStatement(record,key.public_key);return key.public_key;}
async function liveMethod(db:Db,id:string,owner:string){const[m]=await db`select * from app.key_recovery_methods where id=${id} and owner_id=${owner} and disabled_at is null`;if(!m)throw new KeyRecoveryError('Recovery method unavailable');return m;}
export function registerKeyRecovery(app:Hono<{Bindings:Env;Variables:Variables}>){
 app.use('/key-recovery/*',async(c,next)=>{if(c.req.method!=='GET'&&c.env.KEY_RECOVERY_ENABLED!=='true')return error(c,'RECOVERY_NOT_ENABLED',409);await next();});
 app.get('/key-recovery',async c=>c.json(await tx(c,async db=>{
  const member=c.get('memberId');const[settings]=await db`select recovery_setup_required from app.members where id=${member}`;
  const[check]=await db`select kit_checked_at,prompt_dismissed_at from app.key_recovery_checks where member_id=${member}`;
  const methods=await db`select * from app.key_recovery_methods where owner_id=${member} order by created_at`;
  const contacts=await db`select * from app.key_recovery_contacts`;
  const invitations=await db`select m.* from app.key_recovery_methods m join app.key_recovery_contacts c on c.method_id=m.id where c.member_id=${member} and m.disabled_at is null`;
  const requests=await db`select * from app.key_recovery_requests where expires_at>now() and state in ('pending','approved') order by created_at desc limit 30`;
  const responses=await db`select * from app.key_recovery_responses where request_id in (select id from app.key_recovery_requests where expires_at>now() and state='pending')`;
  const devices=await db`select d.id,d.member_id,d.public_key,d.fingerprint,d.revoked_at,(select r.record->'statement'->>'label' from app.key_recovery_requests r where r.owner_id=${member} and r.state='consumed' and r.record->'statement'->>'deviceId'=d.id::text order by r.created_at desc limit 1) as name from app.device_keys d where member_id=${member}`;
  const pairInvitations=await db`select * from app.key_pair_invitations where owner_id=${member} and expires_at>now()`;
  const ids=[...new Set([member,...contacts.flatMap((v:any)=>[v.owner_id,v.member_id])])];
  const handles=await db`select * from app.member_handles(array(select jsonb_array_elements_text(${db.json(ids)}))::uuid[])`;
  return{pairInvitations,enabled:c.env.KEY_RECOVERY_ENABLED==='true',handles,required:c.env.KEY_RECOVERY_ENABLED==='true'&&(settings?.recovery_setup_required??false),check:check??null,methods,contacts,invitations,requests,responses,devices};
 })));
 app.post('/key-recovery/pair-invitations',async c=>{const record=await body(c,z.object({statement:z.object({...identity,purpose:z.literal('porchday-pair-invitation'),id:uuid,fingerprint:fp}).strict(),signature}).strict(),20000),s=record.statement;return c.json(await tx(c,async db=>{
  await author(db,record,c.get('memberId'));const[key]=await db`select fingerprint from app.device_keys where id=${s.deviceId} and member_id=${s.memberId}`;if(key?.fingerprint!==s.fingerprint)throw new KeyRecoveryError('Pairing invitation key mismatch');
  const[{count}]=await db`select count(*)::int count from app.key_pair_invitations where owner_id=${s.memberId} and created_at>now()-interval '1 day'`;if(count>=12)throw new KeyRecoveryError('Pairing invitation limit');
  await db`insert into app.key_pair_invitations(id,owner_id,record,expires_at) values(${s.id},${s.memberId},${db.json(record)},${s.expiresAt})`;return{ok:true};
 }),201);});
 app.post('/key-recovery/methods',async c=>{const record=await body(c,signedMethod,200000),s=record.statement;return c.json(await tx(c,async db=>{
  await author(db,record,c.get('memberId'));await db`select app.bump_epoch()`;
  const[{count}]=await db`select count(*)::int count from app.key_recovery_methods where owner_id=${s.memberId} and disabled_at is null`;if(count>=10)throw new KeyRecoveryError('Recovery method limit');
  const[recovery]=await db`select envelope from app.encrypted_key_backups where member_id=${s.memberId}`;
  if(s.recoveryFingerprint!==recovery?.envelope?.recovery?.fingerprint || (s.passkey&&s.passkey.recoveryFingerprint!==s.recoveryFingerprint))throw new KeyRecoveryError('Recovery identity mismatch');
  if(s.contacts){if(new Set(s.contacts.map(x=>x.memberId)).size!==3||s.contacts.some(x=>x.memberId===s.memberId))throw new KeyRecoveryError('Three distinct contacts required');
   for(const contact of s.contacts){const[key]=await db`select * from app.author_key(${contact.deviceId})`;if(!key||key.member_id!==contact.memberId||key.revoked_at||key.public_key!==contact.publicKey||key.fingerprint!==contact.fingerprint)throw new KeyRecoveryError('Contact key changed');const[connection]=await db`select id from app.connections where member_a=least(${s.memberId}::uuid,${contact.memberId}::uuid) and member_b=greatest(${s.memberId}::uuid,${contact.memberId}::uuid)`;if(!connection)throw new KeyRecoveryError('Choose a current connection');}}
  await db`insert into app.key_recovery_methods(id,owner_id,kind,record) values(${s.id},${s.memberId},${s.kind},${db.json(record)})`;
  for(const contact of s.contacts??[])await db`insert into app.key_recovery_contacts(method_id,owner_id,member_id,device_id) values(${s.id},${s.memberId},${contact.memberId},${contact.deviceId})`;
  return{ok:true};
 }),201);});
 app.post('/key-recovery/actions',async c=>{const record=await body(c,signedAction,20000),s=record.statement;return c.json(await tx(c,async db=>{
  await author(db,record,c.get('memberId'));await db`select app.bump_epoch()`;
  await db`insert into app.key_recovery_action_nonces(id,member_id) values(${s.operationId},${s.memberId})`;
  if(s.action==='complete'){
   const[check]=await db`select kit_checked_at from app.key_recovery_checks where member_id=${s.memberId}`;
   const[{count}]=await db`select count(*)::int count from app.key_recovery_methods where owner_id=${s.memberId} and kind='passkey' and disabled_at is null`;
   const[{paired}]=await db`select count(*)::int paired from app.key_recovery_requests r join app.device_keys d on d.id=(r.record->'statement'->>'deviceId')::uuid where r.owner_id=${s.memberId} and r.kind='pair' and r.state='consumed' and d.member_id=${s.memberId} and d.revoked_at is null`;
   const[{devices}]=await db`select count(*)::int devices from app.device_keys where member_id=${s.memberId} and revoked_at is null`;
   if(!check?.kit_checked_at||(!count&&!(paired>0&&devices>1)))throw new KeyRecoveryError('Verify your recovery kit and a passkey or another device first');
   await db`update app.members set recovery_setup_required=false where id=${s.memberId}`;
  }else if(s.action==='kit-checked'||s.action==='dismiss'){
   if(s.action==='kit-checked'){const[b]=await db`select envelope from app.encrypted_key_backups where member_id=${s.memberId}`;if(b?.envelope?.recovery?.fingerprint!==s.recoveryFingerprint)throw new KeyRecoveryError('Recovery identity mismatch');}
   await db`insert into app.key_recovery_checks(member_id,kit_checked_at,prompt_dismissed_at,proof) values(${s.memberId},${s.action==='kit-checked'?new Date():null},${s.action==='dismiss'?new Date():null},${db.json(record)}) on conflict(member_id) do update set kit_checked_at=coalesce(excluded.kit_checked_at,key_recovery_checks.kit_checked_at),prompt_dismissed_at=coalesce(excluded.prompt_dismissed_at,key_recovery_checks.prompt_dismissed_at),proof=excluded.proof`;
  }else if(s.action==='remove'){
   await liveMethod(db,s.id,s.memberId);
   const[check]=await db`select kit_checked_at from app.key_recovery_checks where member_id=${s.memberId}`;
   const[{count}]=await db`select count(*)::int count from app.key_recovery_methods m where owner_id=${s.memberId} and id<>${s.id} and disabled_at is null and (kind='passkey' or (select count(*) from app.key_recovery_contacts c where c.method_id=m.id and accepted_at is not null and declined_at is null)=3)`;
   if(!check?.kit_checked_at&&!count)throw new KeyRecoveryError('Verify another recovery method first');
   await db`update app.key_recovery_methods set disabled_at=now() where id=${s.id} and owner_id=${s.memberId}`;
   await db`update app.key_recovery_requests set state='cancelled',approval=null where method_id=${s.id} and owner_id=${s.memberId} and state in ('pending','approved')`;
  }else{
   const[contact]=await db`select * from app.key_recovery_contacts where method_id=${s.id} and member_id=${s.memberId}`;if(!contact)throw new KeyRecoveryError('Recovery invitation unavailable');await liveMethod(db,s.id,contact.owner_id);

   await db`update app.key_recovery_contacts set accepted_at=${s.action==='accept'?new Date():null},declined_at=${s.action==='decline'?new Date():null},proof=${db.json(record)} where method_id=${s.id} and member_id=${s.memberId}`;
  }
  return{ok:true};
 }));});
 app.post('/key-recovery/requests',async c=>{const record=await body(c,signedRequest,50000),s=record.statement;
  if(s.memberId!==c.get('memberId')||!fresh(s.expiresAt,s.kind==='pair'?600000:86400000)||(s.kind==='pair')!==(s.methodId===null)||await fingerprint(s.publicKey)!==s.fingerprint)return error(c,'INVALID_RECOVERY_REQUEST');
  await verifyStatement(record,s.publicKey);return c.json(await tx(c,async db=>{
   const[existing]=await db`select record,state,expires_at from app.key_recovery_requests where id=${s.id} and owner_id=${s.memberId}`;if(existing){if(canonicalJson(existing.record)!==canonicalJson(record)||!['pending','approved'].includes(existing.state)||new Date(existing.expires_at).getTime()<=Date.now())throw new KeyRecoveryError('Recovery request unavailable');return{ok:true};}
   if(s.invitationId){const[invitation]=await db`select * from app.key_pair_invitations where id=${s.invitationId} and owner_id=${s.memberId} and expires_at>now() and request_id is null for update`;if(!invitation||s.kind!=='pair')throw new KeyRecoveryError('Pairing invitation expired or already used');}
   const[{count}]=await db`select count(*)::int count from app.key_recovery_requests where owner_id=${s.memberId} and created_at>now()-interval '1 day'`;if(count>=12)throw new KeyRecoveryError('Recovery request limit');
   if(s.methodId){const method=await liveMethod(db,s.methodId,s.memberId);if(method.kind!=='contacts')throw new KeyRecoveryError('Invalid recovery method');const[{count}]=await db`select count(*)::int count from app.key_recovery_contacts where method_id=${s.methodId} and accepted_at is not null and declined_at is null`;if(count<2)throw new KeyRecoveryError('Two accepted contacts required');}
   await db`insert into app.key_recovery_requests(id,owner_id,method_id,kind,record,expires_at) values(${s.id},${s.memberId},${s.methodId},${s.kind},${db.json(record)},${s.expiresAt})`;if(s.invitationId)await db`update app.key_pair_invitations set request_id=${s.id} where id=${s.invitationId} and owner_id=${s.memberId}`;return{ok:true};
  }),201);
 });
 app.post('/key-recovery/responses',async c=>{const record=await body(c,signedResponse,60000),s=record.statement;return c.json(await tx(c,async db=>{
  await author(db,record,c.get('memberId'));
  const[r]=await db`select * from app.key_recovery_requests where id=${s.requestId} and method_id=${s.methodId} and state='pending' and expires_at>now()`;if(!r||r.record.statement.fingerprint!==s.requestFingerprint)throw new KeyRecoveryError('Recovery request expired or changed');
  await liveMethod(db,s.methodId,r.owner_id);
  const[contact]=await db`select * from app.key_recovery_contacts where method_id=${s.methodId} and member_id=${s.memberId} and accepted_at is not null and declined_at is null`;if(!contact)throw new KeyRecoveryError('Recovery contact unavailable');
  await db`insert into app.key_recovery_responses(request_id,member_id,owner_id,record) values(${s.requestId},${s.memberId},${r.owner_id},${db.json(record)}) on conflict(request_id,member_id) do nothing`;return{ok:true};
 }));});
 app.post('/key-recovery/pair-approval',async c=>{const record=await body(c,signedPairing),s=record.statement;return c.json(await tx(c,async db=>{
  await author(db,record,c.get('memberId'));await db`select app.bump_epoch()`;
  const[r]=await db`select * from app.key_recovery_requests where id=${s.requestId} and owner_id=${s.memberId} and kind='pair' and state='pending' and expires_at>now() for update`;if(!r||r.record.statement.fingerprint!==s.requestFingerprint)throw new KeyRecoveryError('Pairing request expired or changed');
  const a=s.authorization?.statement;if(a?.memberId!==s.memberId||a?.authorizingDeviceId!==s.deviceId||a?.deviceId!==r.record.statement.deviceId||a?.fingerprint!==s.requestFingerprint)throw new KeyRecoveryError('Pairing authorization mismatch');
  await db`update app.key_recovery_requests set state='approved',approval=${db.json(record)} where id=${s.requestId} and owner_id=${s.memberId}`;return{ok:true};
 }));});
 app.post('/key-recovery/requests/:id/finish',async c=>{const id=uuid.parse(c.req.param('id'));const b=await body(c,z.object({cancel:z.boolean(),proof:z.any()}).strict(),20000);return c.json(await tx(c,async db=>{
  const[r]=await db`select * from app.key_recovery_requests where id=${id} and owner_id=${c.get('memberId')} and state in ('pending','approved') and expires_at>now() for update`;if(!r)throw new KeyRecoveryError('Recovery request unavailable');
  const s=await verifyStatement<any>(b.proof,r.record.statement.publicKey);if(canonicalJson(s)!==canonicalJson({v:1,purpose:'porchday-recovery-finish',requestId:id,memberId:c.get('memberId'),cancel:b.cancel}))throw new KeyRecoveryError('Invalid recovery completion');
  if(!b.cancel){const[d]=await db`select id from app.device_keys where id=${r.record.statement.deviceId} and member_id=${c.get('memberId')} and revoked_at is null`;if(!d)throw new KeyRecoveryError('Verify the new device before finishing');}
  await db`update app.key_recovery_requests set state=${b.cancel?'cancelled':'consumed'},approval=null where id=${id} and owner_id=${c.get('memberId')}`;return{ok:true};
 }));});
}
