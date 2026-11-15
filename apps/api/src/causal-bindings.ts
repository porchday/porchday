import {causalSpan,causalTraceparent,causalStreamHandoff} from './causal-tracing';
import type {Env} from './types';

/** Bind receiver-sensitive platform methods; never inspect keys or values. */
function bucket(bucket:R2Bucket):R2Bucket{
 return new Proxy(bucket,{get(target,key){
  const value=Reflect.get(target,key);if(typeof value!=='function')return value;
  if(!['get','put','head','delete','list'].includes(String(key)))return value.bind(target);
  return (...args:unknown[])=>causalSpan('r2.'+String(key),async()=>{
   const result=await value.apply(target,args);
   if(key!=='get'||!result)return result;
   let handedOff=false;
   return new Proxy(result,{get(object,property){const member=Reflect.get(object,property);
    if(property==='body'&&member){if(!handedOff){handedOff=true;causalStreamHandoff(object.range?.length??object.size);}return member;}
    if(typeof member!=='function')return member;
    return ['arrayBuffer','text','json','blob'].includes(String(property))?(...args:unknown[])=>causalSpan('r2.body',()=>member.apply(object,args)):member.bind(object);
   }});
  });
 }});
}
export function tracedBindings(env:Env):Env{
 if(env.OPERATIONAL_TRACING!=='true')return env;
 const cache=new Map<PropertyKey,unknown>();
 return new Proxy(env,{get(target,key){
  if(cache.has(key))return cache.get(key);
  const value=Reflect.get(target,key);if(!value)return value;
  let wrapped:unknown=value;
  if(['MEDIA','MEDIA_BACKUP','RECOVERY_JOURNAL'].includes(String(key)))wrapped=bucket(value);
  if(['JOBS','DENIAL_RANGE_0','DENIAL_RANGE_1','DENIAL_RANGE_2'].includes(String(key)))wrapped=new Proxy(value,{get(queue,method){const fn=Reflect.get(queue,method);if(typeof fn!=='function')return fn;
   if(method==='send')return (body:Record<string,unknown>,...args:unknown[])=>causalSpan('queue.send',()=>fn.call(queue,{...body,...(causalTraceparent()?{traceparent:causalTraceparent()}: {})},...args));
   if(method==='sendBatch')return (messages:{body:Record<string,unknown>}[],...args:unknown[])=>causalSpan('queue.sendBatch',()=>fn.call(queue,messages.map(m=>({...m,body:{...m.body,...(causalTraceparent()?{traceparent:causalTraceparent()}: {})}})),...args));
   return fn.bind(queue);
  }});
  if(key==='TRACES'){
   const statement=(original:any):any=>new Proxy(original,{get(target,method){const fn=Reflect.get(target,method);if(typeof fn!=='function')return fn;if(method==='bind')return(...args:unknown[])=>statement(fn.apply(target,args));return ['run','all','first','raw'].includes(String(method))?(...args:unknown[])=>causalSpan('d1.query',()=>fn.apply(target,args)):fn.bind(target);}});
   wrapped=new Proxy(value,{get(db,method){const fn=Reflect.get(db,method);if(method==='prepare')return(sql:string)=>statement(fn.call(db,sql));return method==='batch'?(...args:unknown[])=>causalSpan('d1.query',()=>fn.apply(db,args)):typeof fn==='function'?fn.bind(db):fn;}});
  }
  if(key==='EMAIL')wrapped=new Proxy(value,{get(email,method){const fn=Reflect.get(email,method);return method==='send'?(...args:unknown[])=>causalSpan('email.send',()=>fn.apply(email,args)):typeof fn==='function'?fn.bind(email):fn;}});
  cache.set(key,wrapped);return wrapped;
 }});
}
