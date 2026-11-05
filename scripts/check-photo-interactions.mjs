// Real component/UI, synthetic transport; crypto and RLS are tested separately.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PhotoInteractions} from './apps/web/src/PhotoInteractions';window.rows=[];window.sent=[];window.fail=true;const root=createRoot(document.getElementById('root'));window.renderPhoto=expiry=>root.render(<PhotoInteractions photo={{id:'photo',owner_id:'me',expires_at:expiry}}/>);window.renderPhoto(null);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture',setup(b){
 const mocks={
 './vault':`const vault={member:{id:'me',status:'active'},open:async r=>r.envelope.payload,seal:async(payload,context)=>({payload,context:{...context,id:crypto.randomUUID(),authorId:'me',groupId:null,revision:1}})};export const useVault=()=>vault;`,
 './api':`export const message=e=>e.message;export const items=r=>r.items;export async function get(){return {items:window.rows.filter(r=>r.kind!=='reaction'),own_reaction:window.rows.find(r=>r.kind==='reaction')||null,next:null}};export async function del(path){window.rows=window.rows.filter(r=>!path.endsWith('/'+r.id));return {ok:true}};export async function request(path,options){const {envelope}=JSON.parse(options.body);window.sent.push(envelope.context.id);if(window.fail){window.fail=false;throw Error('Synthetic network failure. Retry.')}if(!window.rows.some(r=>r.id===envelope.context.id)){if(envelope.context.kind==='reaction')window.rows=window.rows.filter(r=>r.kind!=='reaction');window.rows.push({id:envelope.context.id,photo_id:'photo',author_id:'me',author_handle:'synthetic',kind:envelope.context.kind,envelope});}return {ok:true};}`
 };b.onResolve({filter:/^\.\/(vault|api)$/},args=>({path:args.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'tsx',resolveDir:process.cwd()}));
}}]});
const css=await readFile('apps/web/src/styles.css','utf8');
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main><div id="root"></div></main><script>${bundle.outputFiles[0].text}</script></body></html>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();
try{for(const width of [320,390,1200]){
 const page=await browser.newPage({viewport:{width,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Comments & reactions',exact:true}).click();
 await page.getByRole('textbox',{name:'Comment',exact:true}).fill('A lovely photo');
 await page.getByRole('button',{name:'Comment',exact:true}).click();await page.getByText('Synthetic network failure. Retry.').waitFor();
 assert.equal(await page.getByRole('textbox').inputValue(),'A lovely photo');
 await page.getByRole('button',{name:'Comment',exact:true}).click();await page.getByText('A lovely photo',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox').inputValue(),'');assert.equal(await page.evaluate(()=>sent[0]===sent[1]),true);
 await page.getByRole('button',{name:'React ❤️',exact:true}).click();await page.waitForFunction(()=>rows.some(r=>r.envelope.payload.emoji==='love'));
 await page.getByRole('button',{name:'React 👍',exact:true}).click();await page.waitForFunction(()=>rows.filter(r=>r.kind==='reaction').length===1&&rows.some(r=>r.envelope.payload.emoji==='like'));
 await page.getByRole('button',{name:'React 👍',exact:true}).click();await page.waitForFunction(()=>!rows.some(r=>r.kind==='reaction'));
 await page.getByRole('button',{name:'Delete comment',exact:true}).click();await page.waitForFunction(()=>rows.length===0);
 await page.evaluate(()=>window.renderPhoto('2020-01-01T00:00:00.000Z'));await page.getByText('This photo has expired.').waitFor();assert.equal(await page.getByRole('textbox').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await page.close();
}console.log('Photo conversation UI: mobile/desktop, failed-save retry, replacement/removal and deletion passed.');}finally{await browser.close();server.close();}
