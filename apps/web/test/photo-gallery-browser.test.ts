import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {chromium,webkit,type Page} from 'playwright';
const origin='http://localhost:43219';
async function fixture(page:Page,local=false){
 const js=(await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{PhotoGallery,PhotoGalleryGroup,usePhotoGallery}from'./apps/web/src/PhotoGallery';import{invalidatePhotos}from'./apps/web/src/photo-cache';
 window.invalidate=invalidatePhotos;window.pages=[];window.reads=[];window.denied=false;
 const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;canvas.getContext('2d').fillRect(0,0,600,400);const bytes=canvas.toDataURL('image/jpeg').split(',')[1];
 window.fetch=async(url,options={})=>{window.reads.push({url,method:options.method||'GET'});if(window.denied)return new Response(null,{status:403});return options.method==='HEAD'?new Response(null,{status:200}):Response.json({context:{parentId:'post-one',expiresAt:window.expiry||null},payload:{mime:'image/jpeg',bytes}});};
 const photo=id=>({media:{id,mime:'image/jpeg',width:600,height:400,alt:'Caption '+id,name:id}}),video={media:{id:'video',mime:'video/mp4'}};
 const source=(id,ids)=>({id,parentId:id,photos:async()=>ids.map(id=>id==='video'?video:photo(id))});
 function Open(){const open=usePhotoGallery();return <button onClick={e=>open(photo('one').media,undefined,e.currentTarget)}>Open first photo</button>;}
 const more=async cursor=>{window.pages.push(cursor);if(window.failPage)throw Error('More photos could not be loaded. Try again.');return cursor==='p1'?{sources:[source('empty-page',[])],next:'p2'}:{sources:[source('post-four',['four'])],next:null};};
 createRoot(document.getElementById('root')).render(<><PhotoGalleryGroup id='outer-calendar-entry'><PhotoGallery sources={[source('post-one',['one','video','two']),source('text-only',[]),source('post-three',['three'])]} next='p1' loadMore={more}>${local?'<Open/>':"<PhotoGalleryGroup id='post-one'><Open/></PhotoGalleryGroup>"}</PhotoGallery></PhotoGalleryGroup><div style={{height:2000}}/></>);
 `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'vault-fixture',setup(b){b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useVault=()=>({member:{id:'member'},device:{id:'device'},keys:[{getFingerprint:()=> 'key'}],open:async row=>row.envelope.payload});`,loader:'js'}));}}]})).outputFiles[0].text;
 const css=await readFile('apps/web/src/styles.css','utf8')+await readFile('apps/web/src/retro.css','utf8');
 await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js}</script>`}));await page.goto(origin);
}
async function caption(page:Page,id:string){await page.locator('.photo-viewer-stage img').filter({hasNotText:'never'}).waitFor();await expect.poll(()=>page.locator('.photo-viewer-stage img').getAttribute('alt')).toBe('Caption '+id);}
async function swipe(page:Page,dx:number,dy=0){const b=(await page.locator('.photo-viewer-stage').boundingBox())!;const x=b.x+b.width/2,y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:5});await page.mouse.up();}
it.each(['chromium','webkit'] as const)('%s browses across posts/pages, preserves pan and boundaries, and restores focus',async engine=>{
 const browser=await(engine==='chromium'?chromium:webkit).launch();try{const page=await browser.newPage({viewport:{width:390,height:844}});await fixture(page);await page.getByRole('button',{name:'Open first photo'}).click();await caption(page,'one');
 await swipe(page,-90,160);await caption(page,'one');
 await swipe(page,-110);await caption(page,'two');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();await swipe(page,-110);await caption(page,'two');expect(await page.getByRole('button',{name:'Reset photo zoom'}).textContent()).toBe('150%');
 await page.keyboard.press('ArrowRight');await caption(page,'two');await page.getByRole('button',{name:'Reset photo zoom'}).click();await swipe(page,-110);await caption(page,'three');
 await page.evaluate(()=>{(window as any).failPage=true;});await swipe(page,-110);await page.getByRole('status').filter({hasText:'could not be loaded'}).waitFor();await caption(page,'three');
 await page.evaluate(()=>{(window as any).failPage=false;});await page.getByRole('button',{name:'Next photo',exact:true}).click();await caption(page,'four');expect(await page.evaluate(()=>(window as any).pages)).toEqual(['p1','p1','p2']);
 await swipe(page,-110);await page.getByText('No more photos.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Next photo',exact:true}).isDisabled()).toBe(true);
 await swipe(page,110);await caption(page,'three');await page.keyboard.press('ArrowLeft');await caption(page,'two');await swipe(page,110);await caption(page,'one');await swipe(page,110);await page.getByText('This is the first photo.',{exact:true}).waitFor();
 expect(await page.evaluate(()=>(window as any).reads.some((r:any)=>r.url.includes('video')))).toBe(false);
 await page.evaluate(()=>(window as any).invalidate({parentId:'unrelated-post'}));await caption(page,'one');await page.keyboard.press('Escape');expect(await page.getByRole('dialog').count()).toBe(0);await expect.poll(()=>page.getByRole('button',{name:'Open first photo'}).evaluate(e=>e===document.activeElement)).toBe(true);expect(await page.evaluate(()=>document.body.style.overflow)).toBe('');
 }finally{await browser.close();}
},60000);
it('touch pinch and cancelled gestures never switch photos; access invalidation closes the viewer',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});await fixture(page);await page.getByRole('button',{name:'Open first photo'}).click();await caption(page,'one');const b=(await page.locator('.photo-viewer-stage').boundingBox())!,x=b.x+b.width/2,y=b.y+b.height/2,cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-30,y,id:1},{x:x+30,y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-60,y,id:1},{x:x+60,y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await caption(page,'one');expect(parseInt((await page.getByRole('button',{name:'Reset photo zoom'}).textContent())!)).toBeGreaterThan(100);await page.getByRole('button',{name:'Reset photo zoom'}).click();
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x+70,y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70,y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await caption(page,'one');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x+70,y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70,y,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await caption(page,'two');
 await page.evaluate(()=>(window as any).invalidate({parentId:'post-one'}));await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
 }finally{await browser.close();}
},60000);
it('expired photos disappear and denied cache reuse cannot reveal previous bytes',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();await fixture(page);await page.evaluate(()=>{(window as any).expiry=new Date(Date.now()+1500).toISOString();});await page.getByRole('button',{name:'Open first photo'}).click();await caption(page,'one');await page.getByText('This photo expired.',{exact:true}).waitFor();expect(await page.locator('.photo-viewer-stage img').count()).toBe(0);await page.keyboard.press('Escape');await page.evaluate(()=>{(window as any).expiry=null;});await page.getByRole('button',{name:'Open first photo'}).click();await caption(page,'one');await page.keyboard.press('Escape');await page.evaluate(()=>{(window as any).denied=true;});await page.getByRole('button',{name:'Open first photo'}).click();await page.getByText('This photo is no longer available.',{exact:true}).waitFor();expect(await page.locator('.photo-viewer-stage img').count()).toBe(0);
 }finally{await browser.close();}
},60000);
it('the real feed supplies ordered post photos, skips filtered/text/video items and advances its cursor',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage({viewport:{width:390,height:844}});
 const js=(await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PhotoFeed}from'./apps/web/src/PhotoFeed';
 const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;canvas.getContext('2d').fillRect(0,0,600,400);const bytes=canvas.toDataURL('image/jpeg').split(',')[1];
 const media=id=>({id,mime:'image/jpeg',width:600,height:400,alt:id,name:id}),entry=(id,ids,author='self')=>({id,kind:'post',author_id:author,day:'2026-11-14',photo:null,post:{id,author_id:author,created_at:new Date().toISOString(),envelope:{payload:{media:ids.map(id=>id==='video'?{...media(id),mime:'video/mp4'}:media(id))}}}});
 window.feedPages=[];window.fetch=async(url,options={})=>{const u=new URL(url,location.origin);if(u.pathname==='/api/v1/photo-feed'){window.feedPages.push(u.searchParams.get('after'));return Response.json(u.searchParams.get('after')?{items:[entry('p3',['last'])],next:null}:{items:[entry('p1',['first','video','second']),entry('text',[]),entry('filtered',['hidden'],'other')],next:'next-page'});}if(u.pathname.includes('/media/'))return options.method==='HEAD'?new Response(null,{status:200}):Response.json({context:{parentId:'p1',expiresAt:null},payload:{mime:'image/jpeg',bytes}});return Response.json({items:[]});};
 // Keep automatic sentinel prefetch out of this fixture so the viewer must load the next page.
 window.IntersectionObserver=class{observe(){}disconnect(){}unobserve(){}};
 createRoot(document.getElementById('root')).render(<PhotoFeed content='everything' authorFilter={{memberId:'self',audience:'me',selected:['me'],relations:new Map()}}/>);
 `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'feed-fixtures',setup(b){const mocks:Record<string,string>={
 './vault':`export const useVault=()=>({member:{id:'self',status:'active'},device:{id:'device'},keys:[{getFingerprint:()=> 'key'}],open:async row=>row.envelope.payload});export const useOptionalVault=useVault;`,
 './Social':`import React from 'react';import{usePhotoGallery}from'./apps/web/src/PhotoGallery';export function PostCard({row}){const open=usePhotoGallery();return <article>{row.envelope.payload.media.map(m=><button key={m.id} onClick={e=>open(m,undefined,e.currentTarget)}>Open {m.id}</button>)}</article>;}export const EncryptedPhoto=()=>null;`,
 './PhotoCollection':`export const PhotoCard=()=>null;export const openPhoto=async(v,p,g)=>g.envelope.payload;`
 };b.onResolve({filter:/^\.\/(vault|Social|PhotoCollection)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));}}]})).outputFiles[0].text;
 const css=await readFile('apps/web/src/styles.css','utf8');await page.route(origin+'/**',r=>r.fulfill({contentType:'text/html',body:`<style>${css}</style><div id="root"></div><script>${js}</script>`}));await page.goto(origin);await page.getByRole('button',{name:'Open first',exact:true}).click();await page.locator('.photo-viewer-stage img[alt=first]').waitFor();await page.getByRole('button',{name:'Next photo',exact:true}).click();await page.locator('.photo-viewer-stage img[alt=second]').waitFor();await page.getByRole('button',{name:'Next photo',exact:true}).click();await page.locator('.photo-viewer-stage img[alt=last]').waitFor();expect(await page.evaluate(()=>(window as any).feedPages)).toEqual([null,'next-page']);expect(await page.getByRole('button',{name:'Open hidden',exact:true}).count()).toBe(0);
 }finally{await browser.close();}
},60000);

it('a standalone post gallery isolates its own ordering from an outer calendar group',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();await fixture(page,true);await page.getByRole('button',{name:'Open first photo'}).click();await caption(page,'one');await page.getByRole('button',{name:'Next photo',exact:true}).click();await caption(page,'two');}finally{await browser.close();}
},60000);
