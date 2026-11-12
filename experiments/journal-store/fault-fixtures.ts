/** Local test-only classes; never use as deployment entry points. */
import {JournalStoreProbe} from './worker';
export {JournalStoreProbe};
export {default} from './worker';
function faultStorage(original:DurableObjectStorage,mode:'sync'|'transaction'):DurableObjectStorage{
 let armed=true;
 const sql=new Proxy(original.sql,{get(target,key){
  if(key==='exec')return (query:string,...values:SqlStorageValue[])=>{
   const result=target.exec(query,...values);
   if(armed&&mode==='transaction'&&query.startsWith('INSERT INTO records')){armed=false;throw Error('synthetic post-insert failure');}
   return result;
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const storage=new Proxy(original,{get(target,key){
  if(key==='sql')return sql;
  if(key==='sync')return async()=>{if(armed&&mode==='sync'){armed=false;throw Error('synthetic durability-fence failure');}await target.sync();};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 return storage;
}
export class FailedSyncProbe extends JournalStoreProbe {
 private faulty:DurableObjectStorage;
 constructor(ctx:DurableObjectState,env:Record<string,never>){super(ctx,env);this.faulty=faultStorage(ctx.storage,'sync');}
 protected override get store(){return this.faulty;}
}
export class FailedTransactionProbe extends JournalStoreProbe {
 private faulty:DurableObjectStorage;
 constructor(ctx:DurableObjectState,env:Record<string,never>){super(ctx,env);this.faulty=faultStorage(ctx.storage,'transaction');}
 protected override get store(){return this.faulty;}
}
