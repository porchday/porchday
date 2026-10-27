/** Local browser checks with synthetic accounts. No emails or real requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
const root=resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {Connections,Notifications} from './apps/web/src/Community';
function Fixture(){const [path,setPath]=useState(location.pathname);useEffect(()=>{const change=()=>setPath(location.pathname);addEventListener('popstate',change);return()=>removeEventListener('popstate',change)},[]);return path==='/app/connections'?<Connections/>:<Notifications/>}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'synthetic-vault',setup(b){
 b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'synthetic'}));
 b.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:`export const useVault=()=>({member:{id:'self',handle:'self',status:'active'},device:{id:'synthetic'}});export const useOptionalVault=useVault;export const Fingerprint=()=>null;export const VaultProvider=({children})=>children;`,loader:'js'}));
}}]});
const css=await readFile(resolve(root,'apps/web/src/styles.css'));let calls=[];
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),send=(data,status=200,mime='application/json')=>{res.writeHead(status,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(mime==='application/json'?JSON.stringify(data):data);};
 if(url.pathname==='/fixture.js')return send(bundle.outputFiles[0].contents,200,'text/javascript');
 if(url.pathname==='/styles.css')return send(css,200,'text/css');
 if(!url.pathname.startsWith('/api/'))return send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="root"></main><script src="/fixture.js"></script>',200,'text/html');
 if(req.method==='GET'){
  if(url.pathname==='/api/v1/notifications')return send({items:[{id:'joined',kind:'invitation_joined',actor:'new-member',actor_handle:'new_member',created_at:new Date().toISOString(),read_at:null}]});
  if(url.pathname==='/api/v1/connections')return send({items:[],requests:[],handles:[],limit:300});
  if(url.pathname==='/api/v1/platform-invitations')return send({items:[],next_cursor:null});
  return send({items:[]});
 }
 let body='';for await(const chunk of req)body+=chunk;
 calls.push({method:req.method,path:url.pathname,body:JSON.parse(body||'{}')});return send({ok:true});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
try{for(const [name,engine]of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));calls=[];
  await page.goto(origin+'/app/notifications');await page.getByRole('button',{name:/@new_member joined Porchday/}).click();
  await page.getByLabel('Their exact handle').waitFor();assert.equal(await page.getByLabel('Their exact handle').inputValue(),'new_member');
  assert.equal(new URL(page.url()).pathname,'/app/connections');assert.equal(new URL(page.url()).searchParams.get('handle'),'new_member');
  assert.deepEqual(calls,[{method:'PUT',path:'/api/v1/notifications/joined/read',body:{}}]);
  assert.equal(await page.getByLabel('Your label',{exact:true}).inputValue(),'friend');
  assert.equal(await page.getByLabel('Share your posts',{exact:true}).inputValue(),'full');
  await page.getByLabel('Your label',{exact:true}).selectOption('family');await page.getByLabel('Share your posts',{exact:true}).selectOption('future');
  await page.getByRole('button',{name:'Send request',exact:true}).click();await page.getByText('Connection request sent.',{exact:true}).waitFor();
  assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/v1/connections/requests',body:{handle:'new_member',kind:'family',history:'future'}});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log(`${name}: identified invited member, marked read, prefilled connection form, explicit label/history choice, no automatic request, mobile layout passed`);
 }finally{await browser.close();}
}}finally{await new Promise(resolve=>server.close(resolve));}
