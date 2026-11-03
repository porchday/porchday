import {currentJournalDeadline} from './journal-request-deadline';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {AuthPrivacyCommitScope} from './privacy-journal';
import type {TransactionSql,Sql} from 'postgres';
import type {Pool,PoolClient} from 'pg';

const operations=new AsyncLocalStorage<AuthPrivacyCommitScope>();
export function withPrivacyOperation<T>(scope:AuthPrivacyCommitScope,work:()=>Promise<T>){
  if(operations.getStore())throw Error('PRIVACY_OPERATION_NESTED');
  return operations.run(Object.freeze({...scope}),work);
}
export async function enterPrivacyTransaction(db:TransactionSql){
  const scope=operations.getStore();if(!scope)return;
  currentJournalDeadline()?.assertOpen();
  await db`set local transaction_timeout='30s'`;
  await db`set local statement_timeout='10s'`;
  await db`select app.enter_privacy_operation(${scope.operationId}::uuid,${scope.scopeSha256},${scope.generation}::uuid)`;
}
export async function privacySqlTransaction<T>(sql:Sql,work:(db:TransactionSql)=>Promise<T>):Promise<T>{
  return await sql.begin(async db=>{await enterPrivacyTransaction(db);return work(db);}) as T;
}
/** pg pools are often constructed before middleware enters the operation. Read
 * the async context at query dispatch, not at pool construction. No SQL replay. */
export function privacyPool<T extends Pool>(pool:T):T{
  const connect=pool.connect.bind(pool);
  function clientProxy(client:PoolClient,scope:AuthPrivacyCommitScope):PoolClient{
    const raw=client.query.bind(client);let transaction=false;
    const enter=async()=>{
      await raw("SET LOCAL transaction_timeout='30s'");
      await raw("SET LOCAL statement_timeout='10s'");
      await raw('SELECT app.enter_privacy_operation($1::uuid,$2,$3::uuid)',[scope.operationId,scope.scopeSha256,scope.generation]);
    };
    const execute=async(...args:any[])=>{
      // The protected code uses promise-based string/config queries only.
      if(args.some(a=>typeof a==='function'))throw Error('PRIVACY_QUERY_CALLBACK_UNSUPPORTED');
      const text=typeof args[0]==='string'?args[0]:args[0]?.text;
      if(typeof text!=='string')throw Error('PRIVACY_QUERY_INVALID');
      const command=text.trim().replace(/;$/,'').toUpperCase();
      if(command!=='ROLLBACK')currentJournalDeadline()?.assertOpen();
      if(command!=='BEGIN'&&command!=='COMMIT'&&command!=='ROLLBACK'&&/^(BEGIN|START|COMMIT|ROLLBACK|END|ABORT)\b/.test(command))throw Error('PRIVACY_TRANSACTION_COMMAND_UNSUPPORTED');
      if(command==='BEGIN'){
        if(transaction)throw Error('PRIVACY_TRANSACTION_NESTED');
        const result=await raw(...args as [any]);transaction=true;
        try{await enter();return result;}catch(error){await raw('ROLLBACK').catch(()=>{});transaction=false;throw error;}
      }
      if(command==='COMMIT'||command==='ROLLBACK'){
        if(!transaction)throw Error('PRIVACY_TRANSACTION_REQUIRED');
        try{return await raw(...args as [any]);}finally{transaction=false;}
      }
      if(transaction)return raw(...args as [any]);
      await raw('BEGIN');
      try{await enter();const result=await raw(...args as [any]);await raw('COMMIT');return result;}
      catch(error){await raw('ROLLBACK').catch(()=>{});throw error;}
    };
    let tail:Promise<unknown>=Promise.resolve();
    const query=(...args:any[])=>{const result=tail.then(()=>execute(...args));tail=result.then(()=>undefined,()=>undefined);return result;};
    return new Proxy(client,{get:(target,key)=>key==='query'?query:typeof Reflect.get(target,key)==='function'?Reflect.get(target,key).bind(target):Reflect.get(target,key)});
  }
  return new Proxy(pool,{get:(target,key)=>{
    if(key==='connect')return (...args:unknown[])=>{const scope=operations.getStore();if(!scope)return (connect as any)(...args);if(args.length)throw Error('PRIVACY_CONNECT_CALLBACK_UNSUPPORTED');return connect().then(client=>clientProxy(client,scope));};
    if(key==='query')return (...args:any[])=>{
      const scope=operations.getStore();if(!scope)return (pool.query as any)(...args);
      return (async()=>{const client=await connect();try{return await (clientProxy(client,scope).query as any)(...args);}finally{client.release();}})();
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}
