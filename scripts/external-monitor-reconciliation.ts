/** Owner-only synthetic session evidence. Never replay login/logout. */
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {appendFileSync,existsSync} from 'node:fs';
import {atomicJson,privateDirectory,privateFile} from './external-monitor-store';
import {monitorFetch} from './external-monitor-transport';
export type PendingSession={v:1;id:string;cookie:string;createdAt:number;lastCheckedAt:number;expiresAt:number};
const retentionMs=7*24*60*60*1000;
export function sessionReconciliation(directory:string,options:{now?:()=>number;fetch?:typeof fetch}={}){
 privateDirectory(directory);const path=join(directory,'pending-sessions.json'),history=join(directory,'session-reconciliation.jsonl');
 const now=options.now??Date.now;
 let entries:PendingSession[]=existsSync(path)?JSON.parse(privateFile(path)):[];
 if(!Array.isArray(entries)||entries.length>100||entries.some(e=>e.v!==1||!Number.isFinite(e.expiresAt)||!Number.isFinite(e.lastCheckedAt)||!Number.isFinite(e.createdAt)||typeof e.id!=='string'||!/^(__Secure-)?[a-zA-Z0-9_.-]*session_token=[^;\r\n]{1,4096}$/.test(e.cookie)))throw Error('MONITOR_RECONCILIATION_STATE_INVALID');
 const save=()=>atomicJson(path,entries);
 const audit=(id:string,outcome:string,status?:number)=>appendFileSync(history,JSON.stringify({at:new Date(now()).toISOString(),id,outcome,...(status?{status}:{})})+'\n',{mode:0o600});
 return {
  available:()=>entries.length<100,
  capture(cookie:string){
   if(entries.length>=100)throw Error('MONITOR_RECONCILIATION_CAPACITY');
   if(!/^(__Secure-)?[a-zA-Z0-9_.-]*session_token=[^;\r\n]{1,4096}$/.test(cookie))throw Error('MONITOR_RECONCILIATION_COOKIE_INVALID');
   const id=randomUUID(),createdAt=now();entries.push({v:1,id,cookie,createdAt,lastCheckedAt:createdAt,expiresAt:createdAt+retentionMs});save();return id;
  },
  rejected(id:string){audit(id,'rejected',401);entries=entries.filter(e=>e.id!==id);save();},
  async reconcile(){
   // One old session per ordinary cycle; no overlapping probe and no bursts.
   const entry=entries.slice().sort((a,b)=>a.lastCheckedAt-b.lastCheckedAt)[0];if(!entry)return;
   if(now()>=entry.expiresAt){audit(entry.id,'retention_expired_unconfirmed');entries=entries.filter(e=>e.id!==entry.id);save();return;}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
   try{
    const url='https://porchday.org/api/v1/me?bootstrap=1',init={headers:{Cookie:entry.cookie},redirect:'manual' as const,signal:controller.signal};
    const response=await (options.fetch?options.fetch(url,init):monitorFetch(url,init,{phase:'dns',attempts:[]}));
    await response.body?.cancel();
    if(response.status===401){audit(entry.id,'rejected',401);entries=entries.filter(e=>e.id!==entry.id);}
    else{audit(entry.id,response.status===200?'still_authorized':'unconfirmed',response.status);entry.lastCheckedAt=now();}
   }catch{audit(entry.id,'read_failed');entry.lastCheckedAt=now();}
   finally{clearTimeout(timer);save();}
  },
 };
}
