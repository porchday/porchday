import {isDeepStrictEqual} from 'node:util';
import {controlSchema,privacyIntentSchema,sha256,type JournalStore} from '../apps/api/src/privacy-journal';
import {privacyCommitScopeSchema} from '../apps/api/src/privacy-commit-proof';

type Evidence={phase:'intent'|'complete';request:number;method:'get'|'put';key:string;valueSha256?:string;matched?:boolean};
/** Parent-side capability for registration and scope publication only. This is
 * not a recovery/operator override. Never hand the underlying store to a child. */
export function createCommitDrillStore(options:{
 store:JournalStore;assertScope:()=>void;retain:(event:Evidence)=>void|Promise<void>;
 timeoutMs?:number;now?:()=>number;
}){
 const now=options.now??Date.now,started=now(),timeout=options.timeoutMs??5000;
 if(!Number.isInteger(timeout)||timeout<100||timeout>5000)throw Error('DRILL_DEADLINE_INVALID');
 let closed=false,busy=false,count=0,intent:{v:1;id:string;started_at:string}|undefined;
 let original:string|undefined,scopeText:string|undefined;
 let control:{etag:string;text:string}|undefined;
 const need=(value:unknown)=>{if(!value)throw Error('DRILL_STORE_SCOPE');};
 function assert(){need(!closed&&now()-started<60000);options.assertScope();}
 async function call<T>(work:()=>Promise<T>):Promise<T>{
  assert();need(!busy&&count<32);busy=true;count++;let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('DRILL_STORE_DEADLINE')),timeout);})]);}
  catch{closed=true;throw Error('DRILL_STORE_RECONCILIATION_REQUIRED');}
  finally{if(timer)clearTimeout(timer);busy=false;}
 }
 const store:JournalStore={
  async get(key){return call(async()=>{
   need(key==='control.json'||intent&&(key===`intents/${intent.id}.json`||key===`commit-scopes/v1/${intent.id}.json`));
   await options.retain({phase:'intent',request:count,method:'get',key});assert();
   const object=await options.store.get(key);assert();
   let result:null|{etag:string;text:()=>Promise<string>}=null;
   if(object){const text=await object.text();assert();need(Buffer.byteLength(text)<=65536&&typeof object.etag==='string'&&object.etag.length>0);
    if(key==='control.json'){const value=controlSchema.parse(JSON.parse(text));need(value.mode==='active'&&!value.pending.some(p=>now()-Date.parse(p.started_at)>120000));control={etag:object.etag,text};}
    result={etag:object.etag,text:async()=>text};
   }
   await options.retain({phase:'complete',request:count,method:'get',key,matched:result!==null});assert();return result;
  });},
  async put(key,text,input){const condition=structuredClone(input);return call(async()=>{
   need(typeof text==='string'&&Buffer.byteLength(text)<=65536);
   const firstIntent=intent===undefined;
   if(!intent){
    const parsed=privacyIntentSchema.parse(JSON.parse(text));need(key===`intents/${parsed.id}.json`&&Math.abs(now()-Date.parse(parsed.started_at))<=5000);
    need(isDeepStrictEqual(condition,{onlyIf:{etagDoesNotMatch:'*'}}));intent=parsed;original=text;
   }else if(key===`intents/${intent.id}.json`){need(text===original&&isDeepStrictEqual(condition,{onlyIf:{etagDoesNotMatch:'*'}}));}
   else if(key==='control.json'){
    need(control);const before=controlSchema.parse(JSON.parse(control!.text)),after=controlSchema.parse(JSON.parse(text));
    need(!before.pending.some(p=>p.id===intent!.id)&&isDeepStrictEqual(condition,{onlyIf:{etagMatches:control!.etag}}));
    need(isDeepStrictEqual(after,{...before,pending:[...before.pending,{id:intent.id,started_at:intent.started_at}]}));
   }else if(key===`commit-scopes/v1/${intent.id}.json`){
    need(control);const before=controlSchema.parse(JSON.parse(control!.text)),scope=privacyCommitScopeSchema.parse(JSON.parse(text));
    need(before.pending.some(p=>p.id===intent!.id&&p.started_at===intent!.started_at)&&isDeepStrictEqual(condition,{onlyIf:{etagDoesNotMatch:'*'}}));
    need(isDeepStrictEqual(scope,{v:1,id:intent.id,started_at:intent.started_at,generation:before.generation,transaction:'single-auth-transaction',intent_sha256:await sha256(original!),baseline:{sequence:before.sequence,head:before.head}}));
    need(scopeText===undefined||scopeText===text);scopeText=text;
   }else need(false);
   await options.retain({phase:'intent',request:count,method:'put',key,valueSha256:await sha256(text)});assert();
   const result=await options.store.put(key,text,condition);assert();
   // A collision must not let the child adopt a preexisting operation identity.
   if(firstIntent)need(result!==null);
   // A successful CAS invalidates the snapshot; another control write must read anew.
   if(key==='control.json'&&result)control=undefined;
   await options.retain({phase:'complete',request:count,method:'put',key,matched:result!==null});assert();return result;
  });},
 };
 return{store,close(){closed=true;},operationId:()=>intent?.id};
}
