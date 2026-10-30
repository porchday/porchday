import {z} from 'zod';
import type {JournalStore} from '../apps/api/src/privacy-journal';

export type DrillChannel={send:(message:unknown)=>void;subscribe:(receive:(message:unknown)=>void)=>()=>void};
const requestSchema=z.object({type:z.literal('journal'),id:z.number().int().min(1).max(32),method:z.enum(['get','put']),key:z.string().min(1).max(1024),value:z.string().max(65536).optional(),condition:z.object({onlyIf:z.object({etagMatches:z.string().max(256).optional(),etagDoesNotMatch:z.string().max(256).optional()}).strict().optional()}).strict().optional()}).strict();
const responseSchema=z.object({type:z.literal('journal-result'),id:z.number().int().min(1).max(32),ok:z.boolean(),value:z.union([z.null(),z.object({etag:z.string().min(1).max(256),text:z.string().max(65536).optional()}).strict()]).optional()}).strict();
function bounded(value:unknown){try{const text=JSON.stringify(value);if(typeof text!=='string'||Buffer.byteLength(text)>70000)throw Error();return value;}catch{throw Error('DRILL_IPC_INVALID');}}

/** Attach only to an owned child channel; store must be the restricted parent
 * capability. One request in flight, monotonic IDs, fixed failure replies. */
export function serveCommitDrillJournal(channel:DrillChannel,store:JournalStore,onFailure:()=>void){
 let closed=false,busy=false,last=0;
 const unsubscribe=channel.subscribe(message=>{void handle(message);});
 function fail(){if(!closed){closed=true;unsubscribe();try{onFailure();}catch{/* Closed even if the parent's failure sink is unavailable. */}}}
 async function handle(message:unknown){
  let id:number|undefined;
  try{
   if(closed)return;const request=requestSchema.parse(bounded(message));id=request.id;
   if(busy||id!==last+1||request.method==='get'&&(request.value!==undefined||request.condition!==undefined)||request.method==='put'&&request.value===undefined)throw Error();
   busy=true;last=id;let value:null|{etag:string;text?:string};
   if(request.method==='get'){const result=await store.get(request.key);value=result?{etag:result.etag,text:await result.text()}:null;}
   else value=await store.put(request.key,request.value!,request.condition);
   if(closed)return;channel.send(responseSchema.parse(bounded({type:'journal-result',id,ok:true,value})));
  }catch{try{if(id!==undefined)channel.send({type:'journal-result',id,ok:false});}catch{/* Lost replies require reconciliation, never retransmission. */}finally{fail();}}
  finally{busy=false;}
 }
 return{close:fail};
}

/** Child receives only journal results, never the bridge bearer or configuration. */
export function createCommitDrillClient(channel:DrillChannel,timeoutMs=5000){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>5000)throw Error('DRILL_IPC_DEADLINE');
 let closed=false,serial=0,pending:{id:number;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 const unsubscribe=channel.subscribe(message=>{
  try{const response=responseSchema.parse(bounded(message));if(!pending||response.id!==pending.id||!response.ok||!Object.hasOwn(response,'value'))throw Error();const current=pending;pending=undefined;clearTimeout(current.timer);current.resolve(response.value);}
  catch{close();}
 });
 function close(){closed=true;unsubscribe();if(pending){clearTimeout(pending.timer);pending.reject(Error('DRILL_IPC_RECONCILIATION_REQUIRED'));pending=undefined;}}
 async function request(method:'get'|'put',key:string,value?:string,condition?:Parameters<JournalStore['put']>[2]){
  if(closed||pending||serial>=32)throw Error('DRILL_IPC_CLOSED');
  let message:z.infer<typeof requestSchema>;
  try{message=requestSchema.parse(bounded({type:'journal',id:++serial,method,key,...(value===undefined?{}:{value}),...(condition===undefined?{}:{condition})}));}catch{close();throw Error('DRILL_IPC_INVALID');}
  return new Promise<any>((resolve,reject)=>{pending={id:serial,resolve,reject,timer:setTimeout(close,timeoutMs)};try{channel.send(message);}catch{close();}});
 }
 const store:JournalStore={async get(key){const value=await request('get',key);if(value===null)return null;if(typeof value.text!=='string'){close();throw Error('DRILL_IPC_RECONCILIATION_REQUIRED');}return{etag:value.etag,text:async()=>value.text};},async put(key,value,condition){const result=await request('put',key,value,condition);if(result!==null&&Object.hasOwn(result,'text')){close();throw Error('DRILL_IPC_RECONCILIATION_REQUIRED');}return result;}};
 return{store,close};
}
