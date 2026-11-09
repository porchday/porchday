import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const now=new Date(),day=now.toISOString().slice(0,10),calls=[];
const post=(id,author,text,category)=>({id,kind:'post',day,shared_at:now.toISOString(),author_id:author,author_handle:author,author_category:category,author_in_extended_family:author==='family'||author==='cousin',photo:null,post:{id,author_id:author,envelope:{payload:{text,media:id==='with-photo'?[{id:'attached',alt:'Attached photo'}]:[]}}}});
const photo={id:'direct',kind:'photo',day:'2010-01-02',shared_at:now.toISOString(),author_id:'friend',author_handle:'friend',author_category:'friends',photo:{id:'direct',owner_id:'friend',photo_date:'2010-01-02',grants:[{envelope:{payload:{media:[{id:'direct-media',alt:'Old photograph shared today'}]}}}]},post:null};
const posts=[post('with-photo','friend','Post with image','friends'),post('mine','self','My text post','me'),post('family','family','Family update','family'),post('cousin','cousin','Extended family update','extended_family'),post('community','neighbor','Community update','community')];
const attachment={id:'attached',kind:'attachment',day,author_id:'friend',author_handle:'friend',author_category:'friends',photo:null,post:posts[0].post};
let denied=false;
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FeedExperience} from './apps/web/src/FeedExperience';createRoot(document.getElementById('root')).render(<FeedExperience/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'fixture',setup(b){
 const mocks={
 './vault':`const vault={member:{id:'self',status:'active'},open:async row=>row.envelope.payload};export const useVault=()=>vault;export const useOptionalVault=useVault;`,
 './PhotoCollection':`import React from 'react';export const PhotoNotificationDetail=({id})=><aside data-notification-photo={id}>Selected photo</aside>;export const openPhoto=async(v,p,g)=>g.envelope.payload;export const PhotoCard=({photo})=><article data-photo={photo.id}>Old photograph shared today <time>{photo.photo_date}</time></article>;`,
 './Social':`import React from 'react';export const EncryptedPhoto=({media})=><span role="img" aria-label={media.alt}/>;export const PostCard=({row})=><article data-post={row.id}>{row.envelope.payload.text}{row.envelope.payload.media?.map(m=><span key={m.id} role="img" aria-label={m.alt}/>)}</article>;`
 };b.onResolve({filter:/^\.\/(vault|PhotoCollection|Social)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));
}}]});
const css=(await readFile('apps/web/src/styles.css','utf8'))+'\n'+(await readFile('apps/web/src/retro.css','utf8'));
const server=createServer((req,res)=>{const u=new URL(req.url,'http://local');const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(u.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(u.pathname==='/api/v1/connections')return send({items:[{member_a:'self',member_b:'friend',mutual_family:false},{member_a:'self',member_b:'family',mutual_family:true}]});
 if(u.pathname==='/api/v1/photo-feed'){calls.push(Object.fromEntries(u.searchParams));if(denied)return send({error:'FORBIDDEN'},403);const content=u.searchParams.get('content')||'photos',month=u.searchParams.get('month');let entries=content==='posts'?posts:content==='photos'?[photo,attachment]:[photo,...posts];if(month)entries=entries.filter(e=>e.day.startsWith(month));
  if(!month&&!u.searchParams.get('after'))return send({items:[post('unrelated','unknown','Not in this audience',undefined)],next:'second-page'});
  return send({items:entries,next:null});
 }
 if(u.pathname.startsWith('/api/'))return send({items:[]});
 res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="app-main"><div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
try{for(const width of [320,390,1200]){
 denied=false;const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.locator('[data-photo=direct]').waitFor();assert.equal(await page.locator('[data-post]').count(),3);assert.equal(await page.getByRole('img',{name:'Attached photo'}).count(),1);assert.equal(await page.getByText('Not in this audience',{exact:true}).count(),0);
 await page.locator('summary').filter({hasText:'Filters · Everything · Friends & Family'}).click();const show=page.getByRole('combobox',{name:'Show',exact:true}),from=page.getByRole('combobox',{name:'From',exact:true});assert.equal(await show.inputValue(),'everything');assert.equal(await from.inputValue(),'connections');assert.deepEqual(await from.locator('option').allTextContents(),['Only me','Friends','Family','Friends & Family','Extended family','Community']);
 await from.selectOption('me');assert.equal(await page.locator('[data-post]').count(),1);assert.equal(await page.locator('[data-photo]').count(),0);
 await from.selectOption('family');assert.equal(await page.locator('[data-post]').count(),2);
 await from.selectOption('extended_family');assert.equal(await page.locator('[data-post]').count(),3);
 await from.selectOption('community');assert.equal(await page.locator('[data-post]').count(),5);
 await from.selectOption('connections');await show.selectOption('photos');await page.getByRole('link',{name:'View post',exact:true}).waitFor();assert.equal(await page.locator('[data-post]').count(),0);assert.equal(await page.locator('[data-photo]').count(),1);
 await show.selectOption('posts');await page.locator('[data-post=mine]').waitFor();assert.equal(await page.locator('[data-photo]').count(),0);
 await show.selectOption('everything');await page.locator('[data-photo=direct]').waitFor();await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.getByRole('button',{name:new RegExp(day+':')}).waitFor();await page.getByLabel('Jump to month').fill('2010-01');await page.getByRole('button',{name:'2010-01-02: 1 items',exact:true}).click();await page.getByRole('dialog').locator('[data-photo=direct]').waitFor();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Feed',exact:true}).click();await page.locator('[data-photo=direct]').waitFor();assert.equal(await from.inputValue(),'connections');assert.equal(await show.inputValue(),'everything');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.goto(`http://127.0.0.1:${server.address().port}/?photo=direct`);await page.locator('[data-notification-photo=direct]').waitFor();
 denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByRole('alert').waitFor();await page.waitForFunction(()=>document.querySelectorAll('[data-post],[data-photo]').length===0);assert.equal(await page.getByText('Nothing in this view',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);await page.close();
}assert(calls.some(q=>q.content==='everything'&&q.order==='shared'&&q.after));assert(calls.some(q=>q.month==='2010-01'&&!q.order));console.log('Unified Feed defaults, author/content dropdowns, filtered-page continuation, dedup presentation, calendar, access-loss clearing and responsive layout passed.');}finally{await browser.close();await new Promise(r=>server.close(r));}
