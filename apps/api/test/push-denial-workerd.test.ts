import {describe,it,expect} from 'vitest';
import {createECDH,randomBytes,randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {builtinModules} from 'node:module';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import webPush from 'web-push';
// Native workerd + native R2 binding, with all provider traffic intercepted.
// Neither the queue claim functions nor any database is involved.
describe('isolated push denial in workerd',()=>{
 it('uses native R2 authority to suppress denied sessions and fails closed on unreadable authority',async()=>{
  const denied=randomUUID(),allowed=randomUUID(),vapid=webPush.generateVAPIDKeys(),key=createECDH('prime256v1');key.generateKeys();
  const bindings={ENVIRONMENT:'production',SESSION_IDS:JSON.stringify([denied,allowed]),SUBSCRIPTION:JSON.stringify({endpoint:'https://fcm.googleapis.com/wp/synthetic',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}),VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey,VAPID_SUBJECT:'mailto:push@example.test',APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_BUNDLE_ID:'com.porchday.app',APNS_PRIVATE_KEY:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  const bundle=await build({stdin:{contents:`
   import {deliverWebPush} from './apps/api/src/social-push.ts';
   import {deliverNativePush} from './apps/api/src/social-native-push.ts';
   export default {async fetch(request,env){
    const scoped=new URL(request.url).pathname==='/unavailable'?{...env,RECOVERY_JOURNAL:{get:async()=>{throw Error('synthetic-unavailable');}}}:env;
    const result=[];
    for(const sessionId of JSON.parse(env.SESSION_IDS))result.push({
     web:await deliverWebPush(scoped,{sessionId,subscription:JSON.parse(env.SUBSCRIPTION)},1),
     native:await deliverNativePush(scoped,{sessionId,subscription:{token:'ab'.repeat(32),environment:'sandbox'}},1,'synthetic-provider-token'),
    });return Response.json(result);
   }};`,resolveDir:process.cwd(),sourcefile:'push-denial-runtime-test.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],conditions:['workerd','browser'],external:['node:*','cloudflare:*'],target:'es2022',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/push-denial-test.js');"},plugins:[{name:'node-builtins',setup(builder){builder.onResolve({filter:/.*/},args=>builtinModules.includes(args.path)?{path:args.path.startsWith('node:')?args.path:'node:'+args.path,external:true}:undefined);}}]});
  const calls:string[]=[];const mf=new Miniflare(convertV4MiniflareOptions({name:'push-denial-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],bindings,r2Buckets:['RECOVERY_JOURNAL'],outboundService:async(request:Request)=>{calls.push(new URL(request.url).hostname);return new Response(null,{status:200});}}));
  try{
   const bucket=await mf.getR2Bucket('RECOVERY_JOURNAL');const digest=createHash('sha256').update('porchday-session-denial-v1\0'+denied).digest('hex');await bucket.put('session-denials/v1/'+digest+'.json',JSON.stringify({v:1,kind:'session-denial',sessionId:denied}));
   const response=await mf.dispatchFetch('https://test.invalid/check');expect(response.status).toBe(200);expect(await response.json()).toMatchObject([{web:{outcome:'failed'},native:{outcome:'failed'}},{web:{outcome:'sent'},native:{outcome:'sent'}}]);expect(calls).toEqual(['fcm.googleapis.com','api.sandbox.push.apple.com']);
   const unavailable=await mf.dispatchFetch('https://test.invalid/unavailable');expect(await unavailable.json()).toMatchObject([{web:{outcome:'retry'},native:{outcome:'retry'}},{web:{outcome:'retry'},native:{outcome:'retry'}}]);expect(calls).toHaveLength(2);
  }finally{await mf.dispose();}
 });
});
