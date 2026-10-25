// Local-only load probe. Never deploy: deliberately exposes synthetic fixture controls.
import operator from './r2-operator-worker.mjs';
import {beginMediaBackup,copyMediaBackupPage,verifyMediaBackup,type BackupDatabase} from '../apps/api/src/media-backup.js';
import {initializePrivacyJournal,readJournalControl,type JournalStore} from '../apps/api/src/privacy-journal.js';
import {Hono} from 'hono';
import {createSocialRoutes} from '../apps/api/src/social.js';
import productionWorker,{app as productionApp} from '../apps/api/src/index.js';
import type{Env,Variables}from '../apps/api/src/types.js';
const upload=new Hono<{Bindings:Env;Variables:Variables}>();upload.use('*',async(c,next)=>{c.set('memberId',(c.env as any).PROBE_MEMBER);c.set('authTime',Date.now());await next();});upload.route('/api',createSocialRoutes());
let memoryControl:Uint8Array|undefined;
export default {async fetch(request:Request,env:any){
 const path=new URL(request.url).pathname;
 if(path==='/control/footprint')return Response.json({productionRoutesLoaded:productionApp.routes.length,productionEntrypointsLoaded:Object.keys(productionWorker)});
 if(path.startsWith('/api/'))return upload.fetch(request,{...env,MEDIA:env.SOURCE});
 if(path==='/control/allocate'){memoryControl=new Uint8Array(160*1024*1024);memoryControl.fill(17);return Response.json({retainedBytes:memoryControl.byteLength,first:memoryControl[0],last:memoryControl.at(-1)});}
 if(path==='/control/release'){memoryControl=undefined;return Response.json({released:true});}
 const fixture=await(await env.META.get('fixture.json')).json(),run=fixture.run;
 const db:BackupDatabase={journal:{async status(){return{generation:run.generation,sequence:'0',quarantined:false};},async page(){return[];}},async start(){return run;},async info(){return run;},async page(_,cursor){return fixture.items.filter((i:any)=>i.object_key>(cursor??'')).slice(0,8);},async missing(){return null;},async complete(){},async failed(){}};
 const storage={source:env.SOURCE,backup:env.BACKUP,journal:env.JOURNAL as JournalStore,db};
 if(path==='/backup/start'){await initializePrivacyJournal(storage.journal,db.journal);const control=await readJournalControl(storage.journal);await storage.journal.put('control.json',JSON.stringify({...control.value,mode:'active',reason:null}),{onlyIf:{etagMatches:control.etag}});return Response.json({id:await beginMediaBackup(storage)});}
 if(path==='/backup/page')return Response.json({status:await copyMediaBackupPage(storage,run.id)});
 if(path==='/backup/check'){const result=await verifyMediaBackup(env.BACKUP,run.id,run.restore_at);return Response.json({objects:result.objects,bytes:result.bytes});}
 if(path==='/target/verify')return operator.fetch(new Request('https://probe.test/media/verify',request),{...env,MEDIA:env.TARGET});
 return operator.fetch(request,{...env,MEDIA:path==='/backup/restore'?env.TARGET:env.SOURCE});
}};
