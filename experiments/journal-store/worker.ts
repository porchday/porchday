import {DurableObject} from 'cloudflare:workers';
/** Synthetic-only storage experiment. No app binding, real journal or public route. */
export class JournalStoreProbe extends DurableObject<Record<string, never>> {
 constructor(ctx:DurableObjectState,env:Record<string, never>){
  super(ctx,env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, etag TEXT NOT NULL)');
 }
 protected get store():DurableObjectStorage{return this.ctx.storage;}
 async fetch(request:Request):Promise<Response>{
  if(request.method!=='POST')return new Response(null,{status:405});
  const path=new URL(request.url).pathname;
  if(!['/get','/put'].includes(path))return new Response(null,{status:404});
  const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400});
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return new Response(null,{status:413});}chunks.push(value);}}
  catch{return new Response(null,{status:400});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const text=new TextDecoder().decode(bytes);
  let input:any;try{input=JSON.parse(text);}catch{return new Response(null,{status:400});}
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.key!=='string'||!/^synthetic\/[a-f0-9]{32}\/[a-z0-9_-]{1,80}$/.test(input.key))return new Response(null,{status:400});
  if(path==='/get'){
   if(Object.keys(input).some(k=>k!=='key'))return new Response(null,{status:400});
   try{await this.store.sync();
   const row=this.store.sql.exec<{value:string;etag:string}>('SELECT value,etag FROM records WHERE key=?',input.key).toArray()[0];
   return Response.json(row??null);
   }catch{return new Response(null,{status:503});}
  }
  if(Object.keys(input).some(k=>!['key','value','onlyIf'].includes(k))||typeof input.value!=='string'||new TextEncoder().encode(input.value).length>32768)return new Response(null,{status:400});
  const condition=input.onlyIf;
  if(!condition||typeof condition!=='object'||Array.isArray(condition)||Object.keys(condition).length!==1||
   !(condition.etagDoesNotMatch==='*'||typeof condition.etagMatches==='string'&&/^[a-f0-9-]{36}$/.test(condition.etagMatches)))return new Response(null,{status:400});
  try {
  const result=this.store.transactionSync(()=>{
   const current=this.store.sql.exec<{etag:string}>('SELECT etag FROM records WHERE key=?',input.key).toArray()[0];
   if(condition.etagDoesNotMatch==='*'?!!current:current?.etag!==condition.etagMatches)return null;
   if(!current&&this.store.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM records').one().n>=64)throw Error('PROBE_CAPACITY');
   const etag=crypto.randomUUID();
   this.store.sql.exec('INSERT INTO records(key,value,etag) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,etag=excluded.etag',input.key,input.value,etag);
   return {etag};
  });
  // Never return success on an in-memory-only write. Do not bypass output gates.
  await this.store.sync();
  return Response.json(result);
  }catch{return new Response(null,{status:503});}
 }
}
export default {fetch(){return new Response(null,{status:404});}};
