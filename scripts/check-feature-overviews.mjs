/** Local-only real-component keyboard/mobile regression; no member data or network. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';

const original='Scope: delegate one exception.\n\nAcceptance and testing: one use only.\n\nApproach and rollout: stage first.\n\nSources and history: administrative provenance.';
const plan='Proposal overview v1\nSummary: Delegate one scoped surprise.\n\nHighlights:\n- Removes the second feature-specific vote.\n- Private reveals stay private.\n\nOriginal plan:\n'+original;
const fixture=`import React from 'react'; import {createRoot} from 'react-dom/client'; import {FeatureCard} from './apps/web/src/FeatureAdditions';
window.votes=[]; createRoot(document.getElementById('root')).render(<FeatureCard feature={{id:'fixture',title:'One scoped surprise',plan:${JSON.stringify(plan)},status:'voting',score:2,my_vote:0}} busy={false} onVote={value=>window.votes.push(value)}/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
const styles=await readFile(new URL('../apps/web/src/styles.css',import.meta.url));
const server=createServer((req,res)=>{
  if(req.url==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}
  else if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(styles);}
  else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="root" style="max-width:900px;margin:auto;padding:12px"></main><script src="/check.js"></script></html>');}
  else {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  for(const width of [320,390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    await page.goto(origin);
    await page.getByRole('heading',{name:'One scoped surprise'}).waitFor();
    assert.equal(await page.locator('details[open]').count(),0);
    assert.equal(await page.getByText('Removes the second feature-specific vote.',{exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'Support +1'}).isVisible(),true);
    await page.getByRole('button',{name:'Support +1'}).click();
    assert.deepEqual(await page.evaluate(()=>window.votes),[1]);
    const summary=page.locator('summary').filter({hasText:'Complete original plan'});
    await summary.focus();await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(el=>el.parentElement.open),true);
    assert.equal(await summary.locator('..').locator('p').textContent(),original);
    await page.keyboard.press('Space');
    assert.equal(await summary.evaluate(el=>el.parentElement.open),false);
    const accessibility=await page.locator('article').ariaSnapshot();
    assert.match(accessibility,/Complete original plan/);assert.match(accessibility,/Vote on One scoped surprise/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('Feature overview keyboard, accessible names, vote controls and 320/390/1280px layout passed.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
