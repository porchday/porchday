/** Local, signed-out browser regression of the real UI with synthetic API/vault boundaries.
 * No accounts, cookies, inboxes or production services are used. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const owner = '00000000-0000-4000-8000-000000000001';
const friend = '00000000-0000-4000-8000-000000000002';
const photo = '00000000-0000-4000-8000-000000000003';
const friendPhoto = '00000000-0000-4000-8000-000000000009';
const nextPhoto = '00000000-0000-4000-8000-000000000004';
const postId = '00000000-0000-4000-8000-000000000005';
const groupId = '00000000-0000-4000-8000-000000000006';
const device = '00000000-0000-4000-8000-000000000007';
const now = new Date().toISOString();
const envelope = (id, kind, payload, authorId = owner) => ({ context: { id, kind, authorId, authorDeviceId: device, parentId: kind === 'media' ? authorId : null, groupId: null, audience: 'connections', expiresAt: null, createdAt: now, revision: 1, epoch: 1 }, payload, recipients: [], ciphertext: 'synthetic' });
let activePhoto = photo, denied = false, jpeg = '', reads = 0;
const person = { id: owner, handle: 'sample', status: 'active', connection_count: 1 };
const ownProfile = () => envelope(owner, 'profile', { displayName: 'Sample Person', ...(activePhoto ? { avatar: { id: activePhoto } } : {}) });
const post = { id: postId, author_id: owner, created_at: now, expires_at: null, effective_expires_at: null, envelope: envelope(postId, 'post', { text: 'Sample post' }) };
const comment = { id: '00000000-0000-4000-8000-000000000008', post_id: postId, parent_id: null, author_id: owner, created_at: now, expires_at: null, envelope: envelope('00000000-0000-4000-8000-000000000008', 'comment', { text: 'Sample comment' }) };
const bundle = await build({ absWorkingDir: root, entryPoints: ['apps/web/src/main.tsx'], bundle: true, write: false, outdir: 'unused-avatar-test', format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'synthetic-vault', setup(b) {
  b.onResolve({ filter: /^\/(?:fonts\.css|[^/]+\.svg)$/ }, args => ({ path: args.path, external: true }));
  b.onResolve({ filter: /^\.\/vault$/ }, () => ({ path: 'vault', namespace: 'avatar-fixture' }));
  b.onResolve({ filter: /^virtual:dark\.css$/ }, () => ({ path: 'dark.css', namespace: 'avatar-fixture' }));
  b.onLoad({ filter: /dark\.css/, namespace: 'avatar-fixture' }, () => ({ contents: '', loader: 'css' }));
  b.onLoad({ filter: /^vault$/, namespace: 'avatar-fixture' }, () => ({ resolveDir: resolve(root, 'apps/web/src'), loader: 'tsx', contents: `
    import React,{createContext,useContext,useState} from 'react';
    const Context=createContext(null);
    export function VaultProvider({children}) {
      const [profileVersion,setVersion]=useState(0);
      const value={member:${JSON.stringify(person)},device:{id:'${device}'},devices:[],profileVersion,
        open:async row=>row.envelope.payload,clear:async()=>{},notifyProfileChanged:()=>setVersion(v=>v+1)};
      window.avatarFixture=value;return <Context.Provider value={value}>{children}</Context.Provider>;
    }
    export const useVault=()=>useContext(Context),useOptionalVault=useVault;
    export function Fingerprint(){return null;}
  ` }));
} }] });
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).contents;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const send = (data, status = 200, mime = 'application/json') => { res.writeHead(status, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(mime === 'application/json' ? JSON.stringify(data) : data); };
  if (path === '/fixture.js') return send(js, 200, 'text/javascript');
  if (path === '/fixture.css') return send(css, 200, 'text/css');
  if (path === '/api/v1/me') return send({ ...person, envelope: ownProfile() });
  if (path.startsWith('/api/v1/profiles/member/')) return denied ? send({}, 403) : send({ envelope: envelope(friend, 'profile', { avatar: { id: friendPhoto } }, friend) });
  if (path.startsWith('/api/v1/media/')) { reads++; const id = path.split('/')[4]; return send(envelope(id, 'media', { mime: 'image/jpeg', bytes: jpeg }, id === friendPhoto ? friend : owner)); }
  if (path.startsWith('/api/v1/posts/')) return send({ post, comments: [comment], reactions: [], comment_reactions: [] });
  if (path.startsWith('/api/v1/walls/') || path === '/api/v1/feed') return send({ items: [post] });
  if (path === '/api/v1/connections') return send({ items: [{ id: 'connection', member_a: owner, member_b: friend, kind: 'friend', own_history: 'full' }], requests: [], handles: [{ id: friend, handle: 'friend' }] });
  if (path === '/api/v1/groups/' + groupId) return send({ group: { id: groupId, owner_id: owner, envelope: envelope(groupId, 'group', { name: 'Sample group' }) }, members: [{ member_id: owner, role: 'owner' }], handles: [{ id: owner, handle: 'sample' }] });
  if (path === '/api/v1/notifications') return send({ items: [{ id: 'notice', actor: owner, kind: 'comment', post_id: postId, created_at: now }] });
  if (path.startsWith('/api/')) return send({ items: [] });
  if (path.endsWith('.svg')) { try { return send(await readFile(resolve(root, 'apps/web/public' + path)), 200, 'image/svg+xml'); } catch { return send({}, 404); } }
  if (path === '/fonts.css') return send('', 200, 'text/css');
  if (path === '/sw.js') return send('', 200, 'text/javascript');
  send('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', 200, 'text/html');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
      page.setDefaultTimeout(12_000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto('about:blank');
      jpeg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; c.getContext('2d').fillRect(0, 0, 48, 48); return c.toDataURL('image/jpeg').split(',')[1]; });
      activePhoto = photo; denied = false; reads = 0;
      await page.goto(origin + '/app/wall');
      await page.waitForFunction(() => document.querySelectorAll('.member-avatar img').length === 4);
      assert.equal(reads, 1, 'sidebar, wall, composer and post share one photo request');
      await page.getByRole('button', { name: /comment/i }).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.member-avatar img').length === 6);
      assert.equal(reads, 1, 'comments and reply composer reuse the author photo');
      activePhoto = nextPhoto;
      const before = await page.locator('.member-avatar img').first().getAttribute('src');
      await page.evaluate(() => window.avatarFixture.notifyProfileChanged());
      await page.waitForFunction(old => [...document.querySelectorAll('.member-avatar img')].length === 6 && [...document.querySelectorAll('.member-avatar img')].every(img => img.src !== old && img.complete && img.naturalWidth > 0), before);
      assert.equal(reads, 2, 'replacement is loaded once');
      activePhoto = null;
      await page.evaluate(() => window.avatarFixture.notifyProfileChanged());
      await page.waitForFunction(() => document.querySelectorAll('.member-avatar img').length === 0);
      assert.ok((await page.locator('.member-avatar').allTextContents()).every(text => text === 'S'), 'own fallbacks use the handle, not the UUID');
      activePhoto = photo;
      await page.goto(origin + '/app/groups/' + groupId);
      await page.getByRole('button', { name: /Members/ }).first().click();
      await page.waitForFunction(() => !!document.querySelector('.member-row .member-avatar img'));
      await page.goto(origin + '/app/notifications');
      await page.waitForFunction(() => !!document.querySelector('.notification-row .member-avatar img'));
      await page.goto(origin + '/app/connections');
      await page.waitForFunction(() => !!document.querySelector('.member-row .member-avatar img'));
      denied = true;
      await page.evaluate(() => window.dispatchEvent(new Event('porchday:connections-changed')));
      await page.waitForFunction(() => !document.querySelector('.member-row .member-avatar img'));
      assert.equal(await page.locator('.member-row .member-avatar').innerText(), 'F', 'inaccessible profiles use initials');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(origin + '/app/wall');
      await page.waitForFunction(() => !!document.querySelector('.wall-profile .member-avatar img'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile page fits');
      assert.deepEqual(errors, []);
      console.log(`${name}: wall, sidebar, composers, authors, comments, groups, notifications, replacement/removal, fallback, mobile passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
