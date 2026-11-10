import {causalSpan,causalContext,causalCallback} from './causal-tracing';

/** Preserve postgres.js lazy queries and modifiers. Observe execution on first
 * consumption, not query construction. SQL text and bind values are untouched. */
export function causalPostgres<T extends object>(sql:T,role:'auth'|'social'|'jobs'):T{
 const pendingCache=new WeakMap<object,object>();
 function pending(value:any):any{
  if(!value||typeof value.then!=='function')return value;
  if(pendingCache.has(value))return pendingCache.get(value);
  let result:Promise<unknown>|undefined;
  const observe=()=>result??=causalSpan('db.'+role+'.query',()=>value);
  const proxy=new Proxy(value,{get(target,key){
   if(key==='then')return (resolve:unknown,reject:unknown)=>observe().then(resolve as any,reject as any);
   if(key==='catch')return (reject:unknown)=>observe().catch(reject as any);
   if(key==='finally')return (done:unknown)=>observe().finally(done as any);
   const member=Reflect.get(target,key);
   if(typeof member!=='function')return member;
   return (...args:unknown[])=>{const next=member.apply(target,args);return next===target?proxy:pending(next);};
  }});
  pendingCache.set(value,proxy);return proxy;
 }
 return new Proxy(sql,{apply(target:any,receiver,args){return pending(Reflect.apply(target,receiver,args));},get(target,key){
  const value=Reflect.get(target,key);if(typeof value!=='function')return value;
  if(key==='begin')return (...args:unknown[])=>{
   const mapped=args.map(arg=>typeof arg==='function'?(db:any,...rest:unknown[])=>arg(causalPostgres(db,role),...rest):arg);
   return causalSpan('db.transaction',()=>value.apply(target,mapped));
  };
  if(key==='end')return (...args:unknown[])=>causalSpan('db.'+role+'.close',()=>value.apply(target,args));
  if(key==='unsafe')return (...args:unknown[])=>pending(value.apply(target,args));
  return value.bind(target);
 }});
}
/** pg promise API used by auth and bootstrap. Callback/custom query objects
 * retain their original behavior; instrument their enclosing transaction. */
export function causalPgQuery<T extends {query:Function}>(target:T,role:'auth'|'social'|'jobs'):void{
 const query=target.query.bind(target);
 target.query=function(...args:unknown[]){
  if(!causalContext()||(typeof args[0]!=='string'&&typeof (args[0] as {text?:unknown})?.text!=='string'))return query(...args);
  let index=-1;for(let i=args.length-1;i>=0;i--)if(typeof args[i]==='function'){index=i;break;}
  if(index>=0)return causalCallback('db.'+role+'.query',done=>{const callback=args[index] as Function;const forwarded=[...args];forwarded[index]=(...values:unknown[])=>{done(values[0]);return callback(...values);};return query(...forwarded);});
  return causalSpan('db.'+role+'.query',()=>query(...args));
 };
}
