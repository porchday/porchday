import {lookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import type {Socket} from 'node:net';
import {Agent,buildConnector} from 'undici';

export type ConnectionEvidence={phase:'dns'|'tcp'|'tls'|'ready';lookupMs?:number;attempts:{family:number;tcpMs?:number;secureMs?:number;error?:string}[]};
const retryable=new Set(['UND_ERR_CONNECT_TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH']);
/** Fail over only while establishing TLS. The HTTP client receives no socket
 * until certificate verification/secureConnect succeeds, so no application
 * request (especially login/logout) can be replayed by this connector.
 * Keep original SNI/certificate identity; only the resolved address changes. */
export function failoverConnector(evidence:ConnectionEvidence,signal?:AbortSignal|null,options:{
 resolve?:(hostname:string)=>Promise<LookupAddress[]>;connect?:ReturnType<typeof buildConnector>;
}={}):ReturnType<typeof buildConnector>{
 const connect=options.connect??buildConnector({timeout:2000,rejectUnauthorized:true});
 return (params,callback)=>{
  let settled=false,current:Socket|undefined;
  const finish=(error:Error|null,socket?:Socket)=>{
   if(settled){socket?.destroy();return;}settled=true;signal?.removeEventListener('abort',abort);
   if(error){current?.destroy();callback(error,null);}else callback(null,socket!);
  };
  const abort=()=>finish(Object.assign(Error('MONITOR_CONNECTION_ABORTED'),{code:'ABORT_ERR'}));
  if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
  void (async()=>{
   if(params.protocol!=='https:')throw Error('MONITOR_TLS_REQUIRED');
   evidence.phase='dns';const started=performance.now();let timer:ReturnType<typeof setTimeout>|undefined;
   let addresses:LookupAddress[];
   try{addresses=await Promise.race([
    (options.resolve??(hostname=>lookup(hostname,{all:true,order:'ipv4first'})))(params.hostname),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('MONITOR_DNS_DEADLINE'),{code:'EAI_AGAIN'})),1000);}),
   ]);}finally{if(timer!==undefined)clearTimeout(timer);}
   evidence.lookupMs=Math.round(performance.now()-started);if(settled)return;
   // At most two distinct system-resolved addresses; no pinned IP, DNS cache,
   // untrusted redirect, proxy credentials, or certificate-validation bypass.
   const candidates=addresses.filter((a,i)=>addresses.findIndex(b=>b.address===a.address)===i).slice(0,2);
   if(!candidates.length)throw Error('MONITOR_DNS_EMPTY');
   const attempt=(index:number)=>{
    if(settled)return;if(signal?.aborted){abort();return;}
    const record:ConnectionEvidence['attempts'][number]={family:candidates[index].family};evidence.attempts.push(record);evidence.phase='tcp';const began=performance.now();
    const connected:buildConnector.Callback=(error,socket)=>queueMicrotask(()=>{
     if(settled){socket?.destroy();return;}
     if(error){
      const code=(error as NodeJS.ErrnoException).code;record.error=typeof code==='string'&&retryable.has(code)?code:'CONNECTION_FAILED';
      if(typeof code==='string'&&retryable.has(code)&&index+1<candidates.length){current?.destroy();attempt(index+1);return;}
      finish(error);return;
     }
     record.secureMs=Math.round(performance.now()-began);evidence.phase='ready';finish(null,socket);
    });
    try{
     current=connect({...params,hostname:candidates[index].address,servername:params.servername??params.hostname},connected) as unknown as Socket;
     current?.once('connect',()=>{if(!settled){record.tcpMs=Math.round(performance.now()-began);evidence.phase='tls';}});
    }catch(error){connected(error as Error,null);}
   };
   attempt(0);
  })().catch(error=>finish(error));
 };
}

/** A request-scoped dispatcher prevents one failed connection from contaminating
 * another check. Close after the response body; abort destroys outstanding I/O.
 * HTTP failures and ambiguous writes are returned untouched, never retried. */
export async function monitorFetch(url:string,init:RequestInit,evidence:ConnectionEvidence):Promise<Response>{
 const agent=new Agent({connections:1,pipelining:0,connect:failoverConnector(evidence,init.signal)});
 const abort=()=>{void agent.destroy().catch(()=>{});};init.signal?.addEventListener('abort',abort,{once:true});
 const close=()=>{init.signal?.removeEventListener('abort',abort);};
 try{
  const response=await fetch(url,{...init,dispatcher:agent} as RequestInit);
  void agent.close().catch(()=>{}).finally(close);return response;
 }catch(error){await agent.destroy().catch(()=>{});close();throw error;}
}
