/** Real web components in Chromium with isolated synthetic transport.
 * Cryptographic authorization is exercised by photo-calendar.integration.test.ts. */
import assert from "node:assert/strict";
import {generateDeviceKeys} from "@porchday/crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
const self = "00000000-0000-4000-8000-000000000001",
  friend = "00000000-0000-4000-8000-000000000002",
  child = "00000000-0000-4000-8000-000000000003";
const fixtureKeys=await generateDeviceKeys(self,"00000000-0000-4000-8000-000000000099");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {PhotosCalendar} from './apps/web/src/PhotosCalendar';import {ChildrenSettings} from './apps/web/src/ChildrenSettings';import {Composer,EncryptedPhoto} from './apps/web/src/Social';import {validatedVideo} from './apps/web/src/video';window.validateVideo=validatedVideo;window.showMedia=media=>root.render(<EncryptedPhoto media={media}/>);import {PeopleDirectory} from './apps/web/src/PeopleTags';import {AppShell} from './apps/web/src/main';import {isMemberPath} from './apps/web/src/routes';const root=createRoot(document.getElementById('root'));window.fixtureReady.then(()=>root.render(<PeopleDirectory>{location.pathname!=='/'&&isMemberPath(location.pathname)?<AppShell path={location.pathname} routeKey={location.pathname} onLogout={async()=>{}} onAccountDeleted={async()=>{}}/>:location.pathname==='/children'?<ChildrenSettings/>:location.pathname==='/compose'?<Composer onPosted={()=>{}}/>:<PhotosCalendar/>}</PeopleDirectory>));`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  plugins: [
    {
      name: "synthetic-vault",
      setup(b) {
        b.onLoad({ filter: /apps\/web\/src\/main\.tsx$/ }, async (args) => ({
          contents: (await readFile(args.path, "utf8"))
            .split("const canonicalDestination =")[0]
            .replace("function AppShell(", "export function AppShell(")
            .replace(/^import ["\'].*\.css["\'];?$/gm, ""),
          loader: "tsx",
        }));
        b.onResolve({ filter: /^\.\/vault$/ }, () => ({
          path: "vault",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `import {unlockPrivateKey} from '@porchday/crypto';const vault={member:{id:'${self}',handle:'parent',status:'active'},device:{id:'00000000-0000-4000-8000-000000000099'},open:async row=>row.envelope.payload,seal:async(payload,context)=>({payload,context})};window.fixtureReady=unlockPrivateKey(${JSON.stringify(fixtureKeys.encryptedPrivateKey)},${JSON.stringify(fixtureKeys.recoverySecret)}).then(key=>{vault.privateKey=key;});export const useVault=()=>vault;export const useOptionalVault=useVault;export const Fingerprint=()=>null;export const VaultProvider=({children})=>children;`,
          loader: "js",
          resolveDir:process.cwd(),
        }));
      },
    },
  ],
});
const jpeg = JSON.parse(
  await readFile("apps/web/test/fixtures/jpeg-variants.json", "utf8"),
).fixtures.find((f) => f.name === "baseline").base64;
const css = await readFile("apps/web/src/styles.css");
// Exercise the deployed policy: decrypted media uses local blob URLs.
const securityHeaders = Object.fromEntries(
  (await readFile("apps/web/public/_headers", "utf8")).split("\n")
    .filter(line => /^\s+[^:]+:/.test(line))
    .map(line => { const colon = line.indexOf(":"); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]; }),
);
let calls = [];
let highlights = [];
const uploadedMedia = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (data, mime = "application/json") => {
    res.writeHead(200, { ...securityHeaders, "Content-Type": mime });
    res.end(mime === "application/json" ? JSON.stringify(data) : data);
  };
  if (url.pathname === "/logo.svg") return send(await readFile("apps/web/public/logo.svg"),"image/svg+xml");
  if (url.pathname === "/fixture.js")
    return send(bundle.outputFiles[0].contents, "text/javascript");
  if (url.pathname === "/styles.css") return send(css, "text/css");
  if (!url.pathname.startsWith("/api/"))
    return send(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/fixture.js"></script>',
      "text/html",
    );
  let body = "";
  for await (const part of req) body += part;
  calls.push({
    path: url.pathname,
    method: req.method,
    body: body ? JSON.parse(body) : null,
  });
  if (url.pathname === "/api/v1/media" && req.method === "POST") {
    const data = JSON.parse(body);
    uploadedMedia.set(data.id, data.envelope);
    return send({ upload_url: `/api/v1/media/${data.id}/bytes` });
  }
  if (url.pathname.endsWith("/bytes") && req.method === "PUT") return send({ ok: true });
  if (url.pathname.endsWith("/bytes") && uploadedMedia.has(url.pathname.split("/").at(-2)))
    return send(uploadedMedia.get(url.pathname.split("/").at(-2)));
  if (url.pathname.endsWith("/bytes"))
    return send({
      context: { id: "00000000-0000-4000-8000-000000000006", expiresAt: null },
      payload: { mime: "image/jpeg", bytes: jpeg },
    });
  if (url.pathname === "/api/v1/connections")
    return send({
      items: [{ member_a: self, member_b: friend,kind:"friend",mutual_family:false }],
      handles: [
        { id: self, handle: "parent" },
        { id: friend, handle: "friend" },
      ],
    });
  if (url.pathname === "/api/v1/children")
    return send({
      items: [
        {
          id: child,
          owner_id: self,
          can_post: true,
          revision: 1,
          delegates: [],
          envelope: { payload: { name: "Synthetic child" } },
          private_envelope: { payload: { birthday: "2020-02-29" } },
        },
      ],
    });
  if (url.pathname.startsWith("/api/v1/calendar/highlights/")) {
    const date = url.pathname.split("/").at(-1);
    if (req.method === "PUT") highlights = [{ day: date, ...JSON.parse(body) }];
    else highlights = [];
    return send({ ok: true });
  }
  if (url.pathname === "/api/v1/calendar/highlights")
    return send({ items: highlights });
  if(url.pathname==='/api/v1/photo-feed'){
    await new Promise(resolve=>setTimeout(resolve,150));
    const month=url.searchParams.get('month')||new Date().toISOString().slice(0,7),day=month+'-12';
    return send({items:[{id:'00000000-0000-4000-8000-000000000006',kind:'attachment',day,author_id:self,author_handle:'parent',photo:null,post:{id:'00000000-0000-4000-8000-000000000004',author_id:self,created_at:day+'T12:00:00.000Z',expires_at:null,envelope:{payload:{text:'Picnic in the park',media:[{id:'00000000-0000-4000-8000-000000000006',alt:'Synthetic photo',mime:'image/jpeg',width:32,height:24}]}}}}],next:null});
  }
  if (url.pathname === "/api/v1/calendar") {
    await new Promise(resolve=>setTimeout(resolve,150));
    const start = new Date(url.searchParams.get("start"));
    const day = new Date(
      start.getFullYear(),
      start.getMonth(),
      12,
      12,
    ).toISOString();
    return send({
      items: [
        ...[...uploadedMedia.values()].slice(0,1).map(({payload:{bytes,...media}}) => ({id:'00000000-0000-4000-8000-000000000007',author_id:self,author_handle:'parent',created_at:new Date(start.getFullYear(),start.getMonth(),13,12).toISOString(),expires_at:null,envelope:{payload:{text:'Video day',media:[media]}}})),
        {
          id: "00000000-0000-4000-8000-000000000004",
          author_id: self,
          author_handle: "parent",
          created_at: day,
          expires_at: null,
          envelope: {
            payload: {
              text: "Picnic in the park",
              media: [
                {
                  id: "00000000-0000-4000-8000-000000000006",
                  alt: "Synthetic photo",
                  mime: "image/jpeg",
                  name: "synthetic.jpg",
                  width: 32,
                  height: 24,
                },
              ],
              tags: [{ id: child, kind: "child", label: "Synthetic child" }],
            },
          },
        },
        {
          id: "00000000-0000-4000-8000-000000000005",
          author_id: friend,
          author_handle: "friend",
          created_at: day,
          expires_at: null,
          envelope: { payload: { text: "A lovely afternoon" } },
        },
      ],
      next: null,
    });
  }
  return send({ ok: true });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = "http://127.0.0.1:" + server.address().port;
  await page.goto(origin);
  await page
    .getByRole("img", { name: "Synthetic photo", exact: true }).first()
    .waitFor();
  const firstMonth = await page.locator('[data-calendar-month]').first().getAttribute('data-calendar-month');
  const beforeMonths = await page.locator('[data-calendar-month]').count();
  await page.locator('.calendar-earlier').scrollIntoViewIfNeeded();
  const preservedMonth=page.locator(`[data-calendar-month="${firstMonth}"]`);
  await preservedMonth.locator('.loading').waitFor({state:'hidden'});
  const previousTop=(await preservedMonth.boundingBox()).y;
  await page.getByRole('button',{name:'Load earlier month'}).click();
  await page.waitForFunction(before => document.querySelectorAll('[data-calendar-month]').length > before, beforeMonths);
  const monthKeys = await page.locator('[data-calendar-month]').evaluateAll(elements => elements.map(e => e.dataset.calendarMonth));
  assert.equal(monthKeys.at(-1), firstMonth);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert(Math.abs((await preservedMonth.boundingBox()).y-previousTop)<3,"loading an older month preserves the reading anchor");
  await page.locator('[data-calendar-month]').first().getByRole('img',{name:'Synthetic photo',exact:true}).waitFor();
  await page.locator('[data-calendar-month]').first().locator('.loading').waitFor({state:'hidden'});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert(Math.abs((await preservedMonth.boundingBox()).y-previousTop)<3,"loading older month photos preserves the reading anchor");
  assert.equal(new Set(monthKeys).size, monthKeys.length);
  for(let i=1;i<monthKeys.length;i++) assert(monthKeys[i] > monthKeys[i-1]);
  const beforeManual = await page.locator('[data-calendar-month]').count();
  await page.getByRole('button',{name:'Load earlier month'}).click();
  assert(await page.locator('[data-calendar-month]').count()>beforeManual);
  await page.getByRole('heading',{name:'Calendar',exact:true}).scrollIntoViewIfNeeded();
  if (process.env.CALENDAR_SCREENSHOT)
    await page.screenshot({ path: process.env.CALENDAR_SCREENSHOT });
  await page.getByLabel("Tagged person").selectOption("child:" + child);
  await page.getByLabel("Posted by").selectOption(friend);
  assert.equal(
    await page.getByText("Picnic in the park", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: /12: 2 posts/ }).first().click();
  await page
    .getByRole("button", { name: "Feature this post", exact: true })
    .first()
    .click();
  await page.getByText("Your daily highlight was saved.").waitFor();
  assert(
    calls.some(
      (c) =>
        c.method === "PUT" &&
        c.path.includes("/calendar/highlights/") &&
        c.body.post_id.endsWith("004"),
    ),
  );
  const dayTitle = await page.getByRole("dialog").getByRole("heading").textContent();
  async function swipe(dx, dy = 0, target = ".calendar-day-content") {
    await page.locator(target).evaluate((el, {dx, dy}) => {
      const touch = (x,y) => new Touch({identifier:1,target:el,clientX:x,clientY:y});
      el.dispatchEvent(new TouchEvent("touchstart",{bubbles:true,touches:[touch(150,200)]}));
      el.dispatchEvent(new TouchEvent("touchend",{bubbles:true,touches:[],changedTouches:[touch(150+dx,200+dy)]}));
    }, {dx,dy});
  }
  await swipe(-100);
  await page.getByText("No matching posts for this day.").waitFor();
  assert.notEqual(await page.getByRole("dialog").getByRole("heading").textContent(), dayTitle);
  await swipe(100);
  await page.getByRole("dialog").getByText("Picnic in the park", {exact:true}).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("heading").textContent(), dayTitle);
  await swipe(100,150);
  assert.equal(await page.getByRole("dialog").getByRole("heading").textContent(), dayTitle);
  await swipe(-100,0,'[aria-label="Day navigation"] button:first-child');
  assert.equal(await page.getByRole("dialog").getByRole("heading").textContent(), dayTitle);
  for(let i=0;i<12;i++) await page.getByRole("button",{name:"Previous day",exact:true}).click();
  await page.getByText("No matching posts for this day.").waitFor();
  assert(calls.filter(c=>c.path==='/api/v1/calendar').length>=2);
  await page.getByRole("button",{name:"Next day",exact:true}).click();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.goto(origin + "/compose");
  assert.deepEqual(await page.getByRole("combobox",{name:"Post audience",exact:true}).locator("option").allTextContents(),["Friends & family","Friends","Family","Extended family","Community","Only me"]);
  await page.getByRole("button", { name: "Tag people", exact: true }).click();
  await page
    .getByLabel("Tag people", { exact: true })
    .selectOption("member:" + friend);
  await page.getByRole("button", { name: "Remove tag friend" }).waitFor();
  await page.getByLabel("Write a post").fill("A tagged moment");
  await page.getByLabel("Posting on behalf of",{exact:true}).selectOption(child);
  await page.getByRole("button", { name: /Share/ }).click();
  await page.getByText("Post shared.").waitFor();
  assert(
    calls.some(
      (c) =>
        c.path === "/api/v1/posts" &&
        c.body.envelope.payload.tags[0].id === friend,
    ),
  );
  assert(calls.some(c=>c.path==='/api/v1/posts'&&c.body.on_behalf_of===child&&c.body.envelope.payload.tags.some(t=>t.id===child)));
  for (const [extension,mime] of [['mp4','video/mp4'],['mov','video/quicktime']]) {
    const bytes=await readFile(`apps/web/test/fixtures/synthetic-video.${extension}`);
    const result=await page.evaluate(async encoded=>{
      const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const media=await window.validateVideo(bytes);
      return {mime:media.mime,width:media.width,height:media.height,poster:!!media.poster};
    },bytes.toString('base64'));
    assert.deepEqual(result,{mime,width:160,height:120,poster:true});
  }
  // Real browser-generated video; no member data or external media source.
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width=160; canvas.height=120;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='orange'; ctx.fillRect(0,0,160,120);
    const stream=canvas.captureStream(10), recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}), chunks=[];
    const done=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});
    recorder.start();
    await new Promise(resolve=>setTimeout(resolve,250)); ctx.fillStyle='blue';ctx.fillRect(10,10,50,50);
    await new Promise(resolve=>setTimeout(resolve,250)); recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
    const decoded=await window.validateVideo(bytes);
    if(decoded.width!==160||decoded.height!==120||!decoded.poster)throw Error('Video validation failed');
    return btoa(String.fromCharCode(...bytes));
  });
  await page.locator('input[type=file]').setInputFiles({name:'memory.webm',mimeType:'video/webm',buffer:Buffer.from(encoded,'base64')});
  await page.getByLabel('Video preview').waitFor();
  await page.getByLabel('Photo or video description').fill('Synthetic video');
  await page.getByRole('button',{name:/Share/}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Video preview"]'));
  const saved=calls.filter(c=>c.path==='/api/v1/posts').at(-1).body.envelope.payload.media[0];
  assert.equal(saved.mime,'video/webm');assert(saved.poster);assert.equal(saved.posterExpiresAt,null);
  assert.equal(uploadedMedia.get(saved.id).payload.bytes,encoded);
  await page.goto(origin);
  await page.getByRole('button',{name:/13: 1 post/}).first().click();
  await page.getByRole('button',{name:'Feature this video'}).click();
  await page.getByText('Your daily highlight was saved.').waitFor();
  assert(calls.some(c=>c.method==='PUT' && c.path.includes('/calendar/highlights/') && c.body.media_id===saved.id));
  await page.keyboard.press('Escape');
  const videoCell=page.getByRole('button',{name:/13: 1 post/}).first();
  await videoCell.locator('img').waitFor();
  assert(await videoCell.locator('.calendar-video-indicator').evaluate(el=>{const box=el.getBoundingClientRect(),cell=el.closest('button').getBoundingClientRect();return box.left>=cell.left && box.right<=cell.right && box.top>=cell.top && box.bottom<=cell.bottom;}));
  await page.goto(origin + '/video');
  const readsBefore=calls.filter(c=>c.path.endsWith('/bytes')).length;
  await page.evaluate(media=>window.showMedia(media),saved);
  await page.getByRole('button',{name:'Load video'}).waitFor();
  assert.equal(calls.filter(c=>c.path.endsWith('/bytes')).length,readsBefore);
  await page.getByRole('button',{name:'Load video'}).click();
  await page.getByLabel('Synthetic video').waitFor();
  await page.locator('video').evaluate(async video=>{await video.play();});
  assert.equal(await page.locator('video').evaluate(v=>v.videoWidth),160);
  uploadedMedia.get(saved.id).context.expiresAt='2020-01-01T00:00:00.000Z';
  await page.goto(origin + '/video');
  await page.evaluate(media=>window.showMedia({...media,posterExpiresAt:'2020-01-01T00:00:00.000Z'}),saved);
  await page.getByRole('button',{name:'Load video'}).waitFor();
  assert.equal(await page.locator('figure img').count(),0);
  await page.getByRole('button',{name:'Load video'}).click();
  await page.getByText('This attachment expired.').waitFor();
  assert.equal(await page.locator('video').count(),0);
  // Actual decoder rejects a signature-only fake clip.
  assert.equal(await page.evaluate(async()=>{try{await window.validateVideo(new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]));return false;}catch{return true;}}),true);
  await page.goto(origin + "/children");
  await page.getByRole("button", { name: "Add child" }).click();
  await page.getByLabel("Child’s name").fill("Another synthetic child");
  await page.getByLabel("Birthday (private to you)").fill("2021-03-01");
  await page.getByLabel("@friend").check();
  await page.getByRole("button", { name: "Save child" }).click();
  await page.getByText("Child profile saved.").waitFor();
  const save = calls.find(
    (c) => c.method === "PUT" && c.path.startsWith("/api/v1/children/"),
  );
  assert.deepEqual(save.body.delegates, [friend]);
  assert.equal(save.body.envelope.context.audience, "connections");
  assert.equal(save.body.private_envelope.context.audience, "only_me");
  assert.equal(save.body.envelope.payload.birthday, undefined);
  await page.goto(origin + "/photos");
  await page.getByRole('img',{name:'Synthetic photo',exact:true}).first().waitFor();
  await page.locator('.calendar-earlier').scrollIntoViewIfNeeded();
  const photoMonthLabel=await page.locator('.photo-calendar h2').first().textContent();
  const photoMonth=page.locator('.photo-calendar').filter({has:page.getByRole('heading',{name:photoMonthLabel,exact:true})});
  await photoMonth.locator('.loading').waitFor({state:'hidden'});
  const photoMonthTop=(await photoMonth.boundingBox()).y;
  await page.getByRole('button',{name:'Load earlier month',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.photo-calendar').length===2);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert(Math.abs((await photoMonth.boundingBox()).y-photoMonthTop)<3,'photo calendar preserves the reading anchor');
  await page.locator('.photo-calendar').first().getByRole('img',{name:'Synthetic photo',exact:true}).waitFor();
  await page.locator('.photo-calendar').first().locator('.loading').waitFor({state:'hidden'});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert(Math.abs((await photoMonth.boundingBox()).y-photoMonthTop)<3,'photo calendar preserves the anchor after delayed photo loading');
  const thumbnail=page.getByRole('img',{name:'Synthetic photo',exact:true}).first();
  await thumbnail.evaluate(async i=>{await i.decode();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  assert(await thumbnail.evaluate(i=>{const image=i.getBoundingClientRect(),cell=i.closest('button').getBoundingClientRect();return i.naturalWidth===32&&image.width>0&&image.left>=cell.left&&image.right<=cell.right&&image.top>=cell.top&&image.bottom<=cell.bottom;}));
  if(process.env.CALENDAR_SCREENSHOT)await page.screenshot({path:process.env.CALENDAR_SCREENSHOT});
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  assert.deepEqual(await nav.getByRole("link").allTextContents(), [
    "Feed",
    "Share",
    "Albums",
    "Connections",
    "More",
  ]);
  await nav.getByRole("link", { name: "More" }).click();
  await page.locator(".app-mobile-header").getByRole("link").waitFor();
  assert.equal(await page.locator(".app-mobile-header").getByRole("button").count(),0);
  assert.equal(await page.locator(".app-mobile-header").getByRole("link").count(),1);
  const main = page.locator("main");
  await main.getByRole("button",{name:"Log out",exact:true}).waitFor();
  await main.getByRole("link",{name:"Notifications",exact:true}).waitFor();
  await main.getByRole("link", { name: "Builder chat", exact: true }).waitFor();
  assert.equal(
    await main
      .getByRole("link", { name: "My wall", exact: true })
      .getAttribute("href"),
    "/wall",
  );
  assert.equal(
    await main
      .getByRole("link", { name: "Settings", exact: true })
      .getAttribute("href"),
    "/settings/profile",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/share`);
  await page.getByRole('heading',{name:'Add Photos to this Post',exact:true}).waitFor();
  await page.addStyleTag({content:await readFile('apps/web/src/retro.css','utf8')});
  assert.equal(await page.locator('.app-mobile-header').getByRole('link').count(),1);
  assert((await page.locator('.app-mobile-header').boundingBox()).height<=60);
  assert((await page.getByRole('heading',{name:'Share',exact:true}).boundingBox()).height<=1);
  const shortcut=page.getByRole('link',{name:'add photos directly',exact:true});
  await page.locator('textarea').first().fill('Retained draft');
  await shortcut.click();
  await page.getByRole('button',{name:'Post',exact:true}).click();
  assert.equal(await page.locator('textarea').first().inputValue(),'Retained draft');
  assert.equal(await page.getByRole('button',{name:'Photos',exact:true}).count(),1);
  assert.deepEqual(errors, []);
  console.log(
    "Chromium calendar swipes/month boundaries, filters/highlights, video validation/upload/click-to-load playback, encrypted tag payload and child settings passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
