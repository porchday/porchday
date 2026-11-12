import {expect, it} from 'vitest';
import {build} from 'esbuild';
import {chromium, webkit} from 'playwright';

it.each(['chromium', 'webkit'] as const)('%s requires a usable saved secret and checks recovery without writes', async engine => {
  const bundle = await build({stdin: {contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {VaultProvider} from './apps/web/src/vault';
    import {RecoverySettings} from './apps/web/src/RecoverySettings';
    const member={id:'synthetic-member',handle:'synthetic',status:'active',startup_devices:[]};
    createRoot(document.getElementById('root')).render(location.pathname==='/settings/account' ? <RecoverySettings/> : <VaultProvider member={member} onAccountDeleted={async()=>{}}><div>Unlocked</div></VaultProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, format: 'esm', write: false, define: {'process.env.NODE_ENV': '"production"'}});
  const browser = await (engine === 'chromium' ? chromium : webkit).launch();
  try {
    const page = await browser.newPage();
    const requests: {path: string; method: string; body: string}[] = [];
    let backup: unknown;
    await page.route('http://127.0.0.1:43197/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/module.js') return route.fulfill({contentType:'text/javascript', body:bundle.outputFiles[0].text});
      if (path.startsWith('/api/')) {
        requests.push({path, method: request.method(), body: request.postData() || ''});
        if (path === '/api/v1/devices' && request.method() === 'POST') {
          backup = request.postDataJSON().backup;
          // Keep the onboarding UI mounted without enrolling a synthetic device.
          return route.fulfill({status:503, json:{error:'UNAVAILABLE'}});
        }
        if (path === '/api/v1/keys/backup') return route.fulfill({json:{envelope:backup}});
        return route.fulfill({json:{items:[]}});
      }
      return route.fulfill({contentType:'text/html', body:'<main><div id="root"></div></main><script type="module" src="/module.js"></script>'});
    });
    await page.goto('http://127.0.0.1:43197/');
    await page.getByRole('button', {name:'Set up private sharing'}).click();
    await page.locator('.secret-box code').waitFor();
    const secret = (await page.locator('.secret-box code').textContent())!;
    await page.getByRole('button', {name:'I saved it — check my copy'}).click();
    expect(await page.locator('.secret-box').isVisible()).toBe(false);
    await page.getByLabel('Saved encryption recovery secret').fill('x'.repeat(43));
    await page.getByRole('button', {name:'Check secret and continue'}).click();
    await page.getByRole('alert').filter({hasText:'could not unlock'}).waitFor();
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
    await page.getByLabel('Saved encryption recovery secret').fill(secret);
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/v1/devices') && r.request().method() === 'POST'), page.getByRole('button', {name:'Check secret and continue'}).click()]);
    expect(backup).toBeTruthy();
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(secret);
    await page.goto('http://127.0.0.1:43197/settings/account');
    const before = requests.length;
    await page.getByLabel('Saved encryption recovery secret').fill(secret);
    await page.getByRole('button', {name:'Check saved secret'}).click();
    await page.getByRole('status').filter({hasText:'unlocked all backed-up keys'}).waitFor();
    expect(await page.getByLabel('Saved encryption recovery secret').inputValue()).toBe('');
    expect(requests.slice(before)).toEqual([{path:'/api/v1/keys/backup',method:'GET',body:''}]);
    expect(JSON.stringify(requests)).not.toContain(secret);
  } finally { await browser.close(); }
});
