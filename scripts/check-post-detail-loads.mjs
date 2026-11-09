/** Actual Feed/PostCard/Comments browser behavior with synthetic HTTP and vault. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
const engine=process.env.TEST_BROWSER==='webkit'?webkit:chromium;
const override=process.argv[2] ? await readFile(process.argv[2],'utf8') : null;
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Feed,PostCard} from './apps/web/src/Social';
const row=id=>({id,author_id:'self',created_at:new Date().toISOString(),expires_at:null,audience:'only_me',envelope:{ciphertext:id+' text',context:{id,kind:'post',authorId:'self',revision:1,expiresAt:null,audience:'only_me'}}});
function App(){const[id,setId]=useState('post-a');window.setPost=setId;return location.search==='?card'?<PostCard row={row(id)} onChange={()=>{if(window.failRefresh)throw Error("Refresh failed");}}/>:<Feed singleId={id}/>;}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'synthetic',setup(b){
 b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/MemberAvatar$/},()=>({path:'avatar',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='avatar'?'export const MemberAvatar=()=>null;':`export const useVault=()=>({member:{id:'self',status:'active'},device:{id:'device'},open:async row=>({text:row.envelope.ciphertext}),seal:async(payload,context)=>({context,ciphertext:payload.text})});`}));
 if(override)b.onLoad({filter:/\/Social\.tsx$/},()=>({contents:override,loader:'tsx'}));
}}]});
const row=id=>({id,author_id:'self',created_at:new Date().toISOString(),expires_at:null,audience:'only_me',envelope:{ciphertext:id+' text',context:{id,kind:'post',authorId:'self',revision:1,expiresAt:null,audience:'only_me'}}});
const detail=(id,text)=>({post:row(id),comments:[{...row('comment-'+id),post_id:id,parent_id:id,envelope:{ciphertext:text,context:{...row(id).envelope.context,id:'comment-'+id,kind:'comment',parentId:id}}}],reactions:[],comment_reactions:[]});
let reads=[],writes=0,hold=false,pending=[],denied=false,deletes=0,deleteReply=null;
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');}
 res.setHeader('Content-Type','application/json');
 const match=/^\/api\/v1\/posts\/(post-[ab])$/.exec(req.url);
 if(req.method==='DELETE'&&match){deletes++;deleteReply=(status=200)=>{res.statusCode=status;res.end(status===200?'{}':JSON.stringify({error:'Temporary failure'}));};return;}
 if(req.method==='GET'&&match){
  const id=match[1];reads.push(id);
  if(hold&&id==='post-a'&&reads.filter(x=>x===id).length===1)return pending.push(()=>res.end(JSON.stringify(detail(id,'Obsolete comment'))));
  if(denied){res.statusCode=403;return res.end(JSON.stringify({code:'FORBIDDEN'}));}
  return res.end(JSON.stringify(detail(id,writes?'Saved comment':reads.length>1?'Refreshed '+id:'Initial comment')));
 }
 if(req.method==='POST'&&req.url==='/api/v1/posts/post-a/comments'){writes++;res.statusCode=201;return res.end('{}');}
 res.statusCode=404;res.end('{}');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:800}});page.setDefaultTimeout(10000);
 const origin=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const settle=()=>page.waitForTimeout(120);
 const untilRead=async(count)=>{for(let i=0;i<100&&reads.length<count;i++)await new Promise(r=>setTimeout(r,10));assert.equal(reads.length,count);};
 await page.goto(origin);await page.getByText('post-a text',{exact:true}).waitFor();await settle();
 assert.equal(reads.length,1,'single post response supplies post, comments and reactions without refetching');
 await page.getByRole('button',{name:'Newest first',exact:true}).click();await page.getByText('Refreshed post-a',{exact:true}).waitFor();await settle();assert.equal(reads.length,2,'explicit refresh still requests fresh authorized detail');
 await page.locator('.comment-toggle').click();await page.locator('.comments').waitFor({state:'hidden'});await page.locator('.comment-toggle').click();await untilRead(3);await settle();assert.equal(reads.length,3,'reopening comments makes one fresh read');
 // An in-flight initial read may be shared, but a completed write must supersede it.
 reads=[];writes=0;hold=true;pending=[];await page.goto(origin+'/?card');await page.getByText('post-a text',{exact:true}).waitFor();await untilRead(1);
 await page.locator('.comment-toggle').click();await page.locator('.comments').waitFor();await settle();assert.equal(reads.length,1,'opening while initial read is pending shares it');
 await page.locator('.comments textarea').fill('Saved comment');await page.locator('.comments form').getByRole('button',{name:/Comment|Reply/}).click();
 await untilRead(2);await page.locator('.comment').getByText('Saved comment',{exact:true}).waitFor();assert.equal(writes,1);assert.equal(reads.length,2,'post-mutation read must not reuse pending pre-mutation data');
 pending.splice(0).forEach(release=>release());await settle();assert.equal(await page.getByText('Obsolete comment',{exact:true}).count(),0);assert.equal(await page.getByText('Saved comment',{exact:true}).count(),1);
 denied=true;await page.locator('.comment-toggle').click();await page.locator('.comment-toggle').click();await untilRead(3);await page.getByText('This post is no longer available.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Saved comment',{exact:true}).count(),0);assert.equal(await page.getByText('post-a text',{exact:true}).count(),0);
 // Old requests must not publish into a reused card after its post identity changes.
 denied=false;reads=[];writes=0;pending=[];await page.goto(origin+'/?card');await untilRead(1);await page.evaluate(()=>window.setPost('post-b'));await page.getByText('post-b text',{exact:true}).waitFor();await untilRead(2);
 await page.locator('.comment-toggle').click();await page.getByText('Refreshed post-b',{exact:true}).waitFor();pending.splice(0).forEach(release=>release());await settle();
 assert.equal(await page.getByText('Obsolete comment',{exact:true}).count(),0);assert.equal(await page.getByText('Refreshed post-b',{exact:true}).count(),1);assert.deepEqual(errors,[]);
 // Mobile deletion: cancel, held request, failure/retry and stale parent data.
 hold=false;denied=false;await page.setViewportSize({width:390,height:844});await page.goto(origin+'/?card');await page.getByText('post-a text',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Post options',exact:true}).click();page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Delete post',exact:true}).click();assert.equal(deletes,0);assert(await page.getByText('post-a text',{exact:true}).isVisible());
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Delete post',exact:true}).click();await page.getByText('Deleting post…',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Delete post',exact:true}).count(),0);assert.equal(await page.locator('article[data-deletion-state="deleting"]').count(),1);
 await page.waitForFunction(()=>document.querySelector('article[data-deletion-state="deleting"]'));while(!deleteReply)await new Promise(r=>setTimeout(r,10));assert.equal(deletes,1);deleteReply(503);deleteReply=null;
 await page.getByRole('alert').filter({hasText:'Deletion was not confirmed'}).waitFor();assert(await page.getByText('post-a text',{exact:true}).isVisible());
 await page.getByRole('button',{name:'Post options',exact:true}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Delete post',exact:true}).click();await page.getByText('Deleting post…',{exact:true}).waitFor();while(!deleteReply)await new Promise(r=>setTimeout(r,10));assert.equal(deletes,2);await page.evaluate(()=>{window.failRefresh=true;});deleteReply();deleteReply=null;
 await page.getByText('Post deleted.',{exact:true}).waitFor();await page.getByRole('alert').filter({hasText:'Post deleted, but this view could not refresh'}).waitFor();assert.equal(await page.getByText('post-a text',{exact:true}).count(),0);
 // The fixture deliberately never refreshes onChange: success must not depend on it.
 await page.evaluate(()=>window.setPost('post-b'));await page.getByText('post-b text',{exact:true}).waitFor();assert.equal(await page.getByText('Post deleted.',{exact:true}).count(),0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['single initial detail','explicit refresh','comments reopen','shared pending read','fresh mutation read','stale response ignored','denial removes content','identity isolation','mobile delete cancellation','pending deletion feedback','failed deletion restores post','retry succeeds without parent refresh','deleted state identity isolation'],browser:browser.version(),hosted:false,p99Acceptance:false}));
}finally{pending.splice(0).forEach(release=>release());await browser?.close();await new Promise(r=>server.close(r));}
