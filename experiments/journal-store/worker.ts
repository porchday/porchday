import {DurableObject} from 'cloudflare:workers';
/** Synthetic-only storage experiment. No app binding, real journal or public route. */
export class JournalStoreProbe extends DurableObject<Record<string, never>> {
 constructor(ctx:DurableObjectState,env:Record<string, never>){
  super(ctx,env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, etag TEXT NOT NULL)');
 }
 async fetch(request:Request):Promise<Response>{
  if(request.method!=='POST')return new Response(null,{status:405});
  const path=new URL(request.url).pathname;
  if(!['/get','/put'].includes(path))return new Response(null,{status:404});
  const text=await request.text();if(new TextEncoder().encode(text).length>65536)return new Response(null,{status:413});
  let input:any;try{input=JSON.parse(text);}catch{return new Response(null,{status:400});}
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.key!=='string'||!/^synthetic\/[a-f0-9]{32}\/[a-z0-9_-]{1,80}$/.test(input.key))return new Response(null,{status:400});
  if(path==='/get'){
   if(Object.keys(input).some(k=>k!=='key'))return new Response(null,{status:400});
   await this.ctx.storage.sync();
   const row=this.ctx.storage.sql.exec<{value:string;etag:string}>('SELECT value,etag FROM records WHERE key=?',input.key).toArray()[0];
   return Response.json(row??null);
  }
  if(Object.keys(input).some(k=>!['key','value','onlyIf'].includes(k))||typeof input.value!=='string'||new TextEncoder().encode(input.value).length>32768)return new Response(null,{status:400});
  const condition=input.onlyIf;
  if(!condition||typeof condition!=='object'||Array.isArray(condition)||Object.keys(condition).length!==1||
   !(condition.etagDoesNotMatch==='*'||typeof condition.etagMatches==='string'&&/^[a-f0-9-]{36}$/.test(condition.etagMatches)))return new Response(null,{status:400});
  try {
  const result=this.ctx.storage.transactionSync(()=>{
   const current=this.ctx.storage.sql.exec<{etag:string}>('SELECT etag FROM records WHERE key=?',input.key).toArray()[0];
   if(condition.etagDoesNotMatch==='*'?!!current:current?.etag!==condition.etagMatches)return null;
   if(!current&&this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM records').one().n>=64)throw Error('PROBE_CAPACITY');
   const etag=crypto.randomUUID();
   this.ctx.storage.sql.exec('INSERT INTO records(key,value,etag) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,etag=excluded.etag',input.key,input.value,etag);
   return {etag};
  });
  // Never return success on an in-memory-only write. Do not bypass output gates.
  await this.ctx.storage.sync();
  return Response.json(result);
  }catch{return new Response(null,{status:503});}
 }
}
export default {fetch(){return new Response(null,{status:404});}};
