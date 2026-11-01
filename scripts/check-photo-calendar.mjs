/** Real web components in Chromium with isolated synthetic transport.
 * Cryptographic authorization is exercised by photo-calendar.integration.test.ts. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
const self = "00000000-0000-4000-8000-000000000001",
  friend = "00000000-0000-4000-8000-000000000002",
  child = "00000000-0000-4000-8000-000000000003";
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {PhotosCalendar} from './apps/web/src/PhotosCalendar';import {ChildrenSettings} from './apps/web/src/ChildrenSettings';import {Composer} from './apps/web/src/Social';import {PeopleDirectory} from './apps/web/src/PeopleTags';import {AppShell} from './apps/web/src/main';createRoot(document.getElementById('root')).render(<PeopleDirectory>{location.pathname.startsWith('/app/')?<AppShell path={location.pathname} routeKey={location.pathname} onLogout={async()=>{}} onAccountDeleted={async()=>{}}/>:location.pathname==='/children'?<ChildrenSettings/>:location.pathname==='/compose'?<Composer onPosted={()=>{}}/>:<PhotosCalendar/>}</PeopleDirectory>);`,
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
            .split("installTracing();")[0]
            .replace("function AppShell(", "export function AppShell(")
            .replace(/^import ["\'].*\.css["\'];?$/gm, ""),
          loader: "tsx",
        }));
        b.onResolve({ filter: /^\.\/vault$/ }, () => ({
          path: "vault",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `const vault={member:{id:'${self}',handle:'parent',status:'active'},device:{id:'synthetic'},open:async row=>row.envelope.payload,seal:async(payload,context)=>({payload,context})};export const useVault=()=>vault;export const useOptionalVault=useVault;export const Fingerprint=()=>null;export const VaultProvider=({children})=>children;`,
          loader: "js",
        }));
      },
    },
  ],
});
const jpeg = JSON.parse(
  await readFile("apps/web/test/fixtures/jpeg-variants.json", "utf8"),
).fixtures.find((f) => f.name === "baseline").base64;
const css = await readFile("apps/web/src/styles.css");
let calls = [];
let highlights = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (data, mime = "application/json") => {
    res.writeHead(200, { "Content-Type": mime });
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
  if (url.pathname.endsWith("/bytes"))
    return send({
      context: { id: "00000000-0000-4000-8000-000000000006", expiresAt: null },
      payload: { mime: "image/jpeg", bytes: jpeg },
    });
  if (url.pathname === "/api/v1/connections")
    return send({
      items: [{ member_a: self, member_b: friend }],
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
  if (url.pathname === "/api/v1/calendar") {
    const start = new Date(url.searchParams.get("start"));
    const day = new Date(
      start.getFullYear(),
      start.getMonth(),
      12,
      12,
    ).toISOString();
    return send({
      items: [
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
    .getByRole("img", { name: "Synthetic photo", exact: true })
    .waitFor();
  if (process.env.CALENDAR_SCREENSHOT)
    await page.screenshot({ path: process.env.CALENDAR_SCREENSHOT });
  await page.getByLabel("Tagged person").selectOption("child:" + child);
  await page.getByLabel("Posted by").selectOption(friend);
  assert.equal(
    await page.getByText("Picnic in the park", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: /12: 2 posts/ }).click();
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
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.goto(origin + "/compose");
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
  await page.goto(origin + "/app/photos");
  await page.getByRole('img',{name:'Synthetic photo',exact:true}).waitFor();
  const thumbnail=page.getByRole('img',{name:'Synthetic photo',exact:true});
  await thumbnail.evaluate(async i=>{await i.decode();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  assert(await thumbnail.evaluate(i=>{const image=i.getBoundingClientRect(),cell=i.closest('button').getBoundingClientRect();return i.naturalWidth===32&&image.width>0&&image.left>=cell.left&&image.right<=cell.right&&image.top>=cell.top&&image.bottom<=cell.bottom;}));
  if(process.env.CALENDAR_SCREENSHOT)await page.screenshot({path:process.env.CALENDAR_SCREENSHOT});
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  assert.deepEqual(await nav.getByRole("link").allTextContents(), [
    "Home",
    "Connections",
    "Groups",
    "Photos",
    "More",
  ]);
  await nav.getByRole("link", { name: "More" }).click();
  const main = page.locator("main");
  await main.getByRole("link", { name: "Builder chat", exact: true }).waitFor();
  assert.equal(
    await main
      .getByRole("link", { name: "My wall", exact: true })
      .getAttribute("href"),
    "/app/wall",
  );
  assert.equal(
    await main
      .getByRole("link", { name: "Settings", exact: true })
      .getAttribute("href"),
    "/app/settings/profile",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Chromium mobile calendar, author/tag filters, personal highlight, encrypted tag payload and child settings passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
