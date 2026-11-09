import {Hono,type Context} from 'hono';
import {z} from 'zod';
import {canonicalJson,verifyStatement,type EncryptedEnvelope} from '@porchday/crypto';
import {withMember,type Db} from './db';
import {runtimeSessionDenied} from './session-denial';
import type {Env,Variables} from './types';
const uuid=z.string().uuid(),base64=z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const identity=z.object({v:z.literal(1),purpose:z.literal('porchday-notification-key'),memberId:uuid,deviceId:uuid,keyId:uuid,publicKey:base64.length(88)}).strict();
const certificate=z.object({statement:identity,signature:z.string().max(8192)}).strict();
export const notificationPreviewSchema=z.object({statement:z.object({context:z.object({v:z.literal(1),purpose:z.literal('porchday-notification-preview'),kind:z.enum(['post','photo']),id:uuid,authorId:uuid,authorDeviceId:uuid,revision:z.number().int().positive(),expiresAt:z.string().datetime({offset:true}).nullable()}).strict(),iv:base64.length(16),ciphertext:base64.max(40000),recipients:z.array(z.object({keyId:uuid,memberId:uuid,deviceId:uuid,ephemeral:base64.length(88),iv:base64.length(16),ciphertext:base64.length(64)}).strict()).min(1).max(1000)}).strict(),signature:z.string().max(8192)}).strict();
type C=Context<{Bindings:Env;Variables:Variables}>;
type Dependencies={tx<T>(c:C,fn:(db:Db)=>Promise<T>):Promise<T>;body<T>(c:C,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;fail(code:string,status?:400|403|404|409|413|429):never};
export function registerNotificationPreviewRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body,fail}:Dependencies){
 app.post('/notification-previews/keys',async c=>{const b=await body(c,z.object({certificate,native:z.boolean(),subscription_id:uuid}).strict(),20000),i=b.certificate.statement;if(i.memberId!==c.get('memberId'))fail('FORBIDDEN',403);
 await crypto.subtle.importKey('raw',Uint8Array.from(atob(i.publicKey),x=>x.charCodeAt(0)),{name:'ECDH',namedCurve:'P-256'},false,[]);
 return c.json(await tx(c,async db=>{const[d]=await db`select id,public_key from app.device_keys where id=${i.deviceId} and member_id=${i.memberId} and revoked_at is null`;if(!d)fail('FORBIDDEN',403);await verifyStatement(b.certificate,d.public_key);
 const subscriptions=b.native?await db`select id from app.native_push_subscriptions where id=${b.subscription_id} and member_id=${i.memberId} and session_id=${c.get('sessionId')}`:await db`select id from app.push_subscriptions where id=${b.subscription_id} and member_id=${i.memberId} and session_id=${c.get('sessionId')}`;if(!subscriptions.length)fail('FORBIDDEN',403);
 const[existing]=await db`select * from app.notification_preview_keys where id=${i.keyId}`;
 if(existing){if(existing.session_id!==c.get('sessionId')||canonicalJson(existing.certificate.statement)!==canonicalJson(i)||(b.native?existing.native_subscription:existing.web_subscription)!==b.subscription_id)fail('CONFLICT',409);return{ok:true};}
 if(b.native)await db`delete from app.notification_preview_keys where native_subscription=${b.subscription_id}`;else await db`delete from app.notification_preview_keys where web_subscription=${b.subscription_id}`;
 await db`insert into app.notification_preview_keys(id,member_id,device_id,session_id,web_subscription,native_subscription,certificate) values(${i.keyId},${i.memberId},${i.deviceId},${c.get('sessionId')},${b.native?null:b.subscription_id},${b.native?b.subscription_id:null},${db.json(b.certificate)})`;return{ok:true};}));});
 app.post('/notification-previews/recipients',async c=>{const b=await body(c,z.object({devices:z.array(uuid).max(4000)}).strict(),200000);return c.json({items:await tx(c,db=>db`select k.id,k.member_id,k.device_id,k.certificate,to_jsonb(d) as author_key from app.preview_recipient_keys(${b.devices}::uuid[]) k join lateral app.author_key(k.device_id) d on true limit 1000`)});});
 app.delete('/notification-previews/keys',async c=>c.json(await tx(c,async db=>{await db`delete from app.notification_preview_keys where member_id=${c.get('memberId')} and session_id=${c.get('sessionId')}`;return{ok:true};})));
}
export async function storeNotificationPreview(db:Db,owner:string,value:unknown,envelopes:EncryptedEnvelope[],kind:'post'|'photo',id:string){
 if(value===undefined)return;const signed=notificationPreviewSchema.parse(value),p=signed.statement,context=p.context,source=envelopes[0].context;
 if(context.id!==id||context.kind!==kind||context.authorId!==owner||context.authorDeviceId!==source.authorDeviceId||context.revision!==source.revision||context.expiresAt!==source.expiresAt)throw Error('PREVIEW_CONTEXT_MISMATCH');
 const[author]=await db`select public_key from app.device_keys where id=${context.authorDeviceId} and member_id=${owner} and revoked_at is null`;if(!author)throw Error('PREVIEW_AUTHOR_UNAVAILABLE');await verifyStatement(signed,author.public_key);
 const recipients=envelopes.flatMap(e=>e.recipients);
 if(new Set(p.recipients.map(r=>r.keyId)).size!==p.recipients.length||p.recipients.some(r=>!recipients.some(x=>x.deviceId===r.deviceId&&x.memberId===r.memberId)))throw Error('PREVIEW_AUDIENCE_MISMATCH');
 await db`insert into app.notification_previews(id,owner_id,post_id,photo_id,revision,signed_preview) values(${id},${owner},${kind==='post'?id:null},${kind==='photo'?id:null},${context.revision},${db.json(signed)})`;
}
/** Notification-scoped capability, never an account session credential. POST keeps it out of URLs/logs. */
export const notificationPreviewDelivery=new Hono<{Bindings:Env;Variables:Variables}>();
notificationPreviewDelivery.post('/',async c=>{c.header('Cache-Control','no-store');const input=z.object({token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(await c.req.json().catch(()=>null));if(!input.success)return c.json({error:{code:'NOT_FOUND'}},404);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.data.token))),x=>x.toString(16).padStart(2,'0')).join('');
 const result=await withMember(c.env,'00000000-0000-0000-0000-000000000000',async db=>{const[row]=await db`select app.redeem_notification_preview(${digest}) as result`;return row?.result;});
 if(!result||await runtimeSessionDenied(c.env,result.sessionId))return c.json({error:{code:'NOT_FOUND'}},404);delete result.sessionId;return c.json(result);
});
