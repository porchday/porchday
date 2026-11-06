import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {PhotoViewer} from './apps/web/src/PhotoViewer';function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open photo</button>{open&&<PhotoViewer src='/sample.svg' alt='A sample landscape' onClose={()=>setOpen(false)}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}});
const css=await readFile('apps/web/src/styles.css','utf8')+'\n'+await readFile('apps/web/src/retro.css','utf8');
const server=createServer((req,res)=>{if(req.url==='/sample.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#7699a8"/><path d="M0 800L400 180L800 800M400 800L950 250L1200 800" fill="#60744e"/></svg>');return;}res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();try{for(const width of [320,390,1200]){
 const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Open photo',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Photo viewer'});await dialog.waitFor();
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');assert.equal(await page.locator('.photo-viewer-caption').evaluate(e=>getComputedStyle(e).color),'rgb(244, 231, 220)');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();await page.getByRole('button',{name:'Reset photo zoom'}).filter({hasText:'150%'}).waitFor();
 const stage=page.locator('.photo-viewer-stage'),bounds=await stage.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+30,bounds.y+bounds.height/2+20);await page.mouse.up();
 assert.match(await stage.locator('img').getAttribute('style',{timeout:5000}),/translate\(30px, 20px\)/);
 await page.getByRole('button',{name:'Reset photo zoom'}).click();assert.match(await stage.locator('img').getAttribute('style'),/scale\(1\)/);
 await stage.dblclick();assert.match(await stage.locator('img').getAttribute('style'),/scale\(2\)/);
 await page.mouse.wheel(0,-100);await page.waitForFunction(()=>parseInt(document.querySelector('[aria-label="Reset photo zoom"]').textContent)>200);
 await page.keyboard.press('0');await page.getByRole('button',{name:'Reset photo zoom'}).filter({hasText:'100%'}).waitFor();
 const cdp=await page.context().newCDPSession(page);const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-25,y,id:1},{x:x+25,y,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-60,y,id:1},{x:x+60,y,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForFunction(()=>parseInt(document.querySelector('[aria-label="Reset photo zoom"]').textContent)>100);
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await page.getByRole('button',{name:'Open photo'}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('button',{name:'Open photo'}).click();await page.getByRole('button',{name:'Close photo viewer'}).click();assert.equal(await page.evaluate(()=>document.body.style.overflow),'');assert.deepEqual(errors,[]);await page.close();
}console.log('Photo viewer: responsive layout, zoom, drag, reset, Escape, close and focus restoration passed.');}finally{await browser.close();server.close();}
