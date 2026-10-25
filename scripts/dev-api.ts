import {serve} from '@hono/node-server';
import {Pool} from 'pg';
import {mkdir,readFile,writeFile,unlink,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {app} from '../apps/api/src/index.ts';
import type {Env} from '../apps/api/src/types.ts';
// Local synthetic development only. Objects are the same ciphertext uploaded in production.
const root=resolve('artifacts/private/dev');await mkdir(root,{recursive:true,mode:0o700});
const owner=new Pool({connectionString:'postgres://postgres:porchday-local@localhost:54329/porchday'});
for(const role of ['auth','social','jobs'])await owner.query(`ALTER ROLE porchday_${role} LOGIN PASSWORD 'porchday-local-${role}'`);
await owner.end();
const writes:Promise<unknown>[]=[];
const env={
 APP_URL:'http://localhost:5173',ENVIRONMENT:'development',SIGNUP_ENABLED:'true',
 BETTER_AUTH_SECRET:'development-only-porchday-auth-secret-not-for-production',EMAIL_FROM:'Porchday <accounts@porchday.com>',
 HYPERDRIVE_AUTH:{connectionString:'postgres://porchday_auth:porchday-local-auth@localhost:54329/porchday'},
 HYPERDRIVE_SOCIAL:{connectionString:'postgres://porchday_social:porchday-local-social@localhost:54329/porchday'},
 HYPERDRIVE_JOBS:{connectionString:'postgres://porchday_jobs:porchday-local-jobs@localhost:54329/porchday'},
 EMAIL:{async send(message:unknown){const path=resolve(root,'email-'+crypto.randomUUID()+'.json');await writeFile(path,JSON.stringify(message),{mode:0o600});console.log('Synthetic email captured privately.');return {messageId:'development'};}},
 MEDIA:{
  async put(key:string,value:ReadableStream|ArrayBuffer|Uint8Array,options?:unknown){const bytes=new Uint8Array(await new Response(value as BodyInit).arrayBuffer());const name=encodeURIComponent(key);await writeFile(resolve(root,name),bytes,{mode:0o600});return {key,size:bytes.length};},
  async get(key:string){try{const bytes=await readFile(resolve(root,encodeURIComponent(key)));return {body:new Blob([bytes]).stream(),size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}catch{return null;}},
  async head(key:string){try{return {key,size:(await stat(resolve(root,encodeURIComponent(key)))).size};}catch{return null;}},
  async delete(key:string|string[]){await Promise.all((Array.isArray(key)?key:[key]).map(k=>unlink(resolve(root,encodeURIComponent(k))).catch(()=>{})));},
 },
 ASSETS:{fetch:async()=>new Response('Use the Vite frontend on localhost:5173.',{status:404})},
 JOBS:{send:async()=>{}},
} as unknown as Env;
serve({port:8787,hostname:'127.0.0.1',fetch:request=>app.fetch(request,env,{waitUntil(p:Promise<unknown>){writes.push(p.catch(()=>{}));},passThroughOnException(){},props:{}} as ExecutionContext)},info=>console.log('Local synthetic API listening on port '+info.port));
