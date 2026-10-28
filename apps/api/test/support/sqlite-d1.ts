import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

/** Minimal D1 stand-in over Node's SQLite for the trace store's real SQL. */
export function sqliteD1(migration='apps/api/d1/traces/0001_create_traces.sql') {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(migration,'utf8'));
 const calls={batches:0,statements:0};
 type Bound={sql:string;args:unknown[]};
 const execute=({sql,args}:Bound)=>{
  calls.statements++;
  const statement=sqlite.prepare(sql),started=performance.now();
  if(/^\s*select/i.test(sql)){
   const results=statement.all(...args as never[]) as Record<string,unknown>[];
   return {success:true,results,meta:{duration:performance.now()-started,rows_read:results.length,rows_written:0,changes:0}};
  }
  const info=statement.run(...args as never[]);
  return {success:true,results:[],meta:{duration:performance.now()-started,rows_read:0,rows_written:Number(info.changes),changes:Number(info.changes)}};
 };
 const prepare=(sql:string)=>{
  const make=(args:unknown[]):Bound&{bind:(...next:unknown[])=>unknown;all:()=>Promise<unknown>;run:()=>Promise<unknown>}=>({
   sql,args,bind:(...next:unknown[])=>make(next),
   all:async()=>execute({sql,args}),run:async()=>execute({sql,args}),
  });
  return make([]);
 };
 const db={
  prepare,
  async batch(statements:Bound[]){
   calls.batches++;
   sqlite.exec('BEGIN');
   try{const results=statements.map(execute);sqlite.exec('COMMIT');return results;}
   catch(error){sqlite.exec('ROLLBACK');throw error;}
  },
 };
 return {db:db as unknown as D1Database,sqlite,calls};
}
