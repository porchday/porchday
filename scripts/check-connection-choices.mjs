/** Local-only connection-choice UI checks. Uses synthetic data and no member sessions. */
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { Connections } from './apps/web/src/Community';
      window.sharingChecks = 0;
      window.addEventListener('porchday:connections-changed', () => window.sharingChecks++);
      createRoot(document.getElementById('root')).render(React.createElement(Connections));`,
    resolveDir: root, loader: "tsx",
  },
  plugins: [{ name: "synthetic-vault", setup(builder) {
    builder.onResolve({ filter: /^\.\/vault$/ }, () => ({ path: "synthetic-vault", namespace: "synthetic" }));
    builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: `
      export const useVault = () => ({ member: { id: 'self', handle: 'self', status: 'active' } });
      export const useOptionalVault = useVault;
      export const Fingerprint = () => null;
      export const VaultProvider = ({children}) => children;`, loader: "js" }));
  } }],
  bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
});
const styles = await readFile(new URL("../apps/web/src/styles.css", import.meta.url));
let state;
const reset = (options = {}) => {
  state = {
    items: [{ id: "existing", member_a: "self", member_b: "person", kind: "family", own_history: "future", peer_history: "full" }],
    requests: [{ id: "incoming", sender: "new-person", recipient: "self", kind: null, history: "full" }],
    handles: [{ id: "person", handle: "person" }, { id: "new-person", handle: "new_person" }],
    calls: [], failKind: false, ...options,
  };
};
reset();
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/check.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); return;
  }
  if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css"); response.end(styles); return;
  }
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="root" style="max-width:1000px;margin:auto"></main><script src="/check.js"></script>'); return;
  }
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/api/v1/connections") {
    response.end(JSON.stringify({ items: state.items, requests: state.requests, handles: state.handles, limit: 300 })); return;
  }
  if (request.method === "GET" && request.url === "/api/v1/mutes") { response.end('{"items":[]}'); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  state.calls.push({ method: request.method, path: request.url, body });
  if (request.method === "POST" && request.url === "/api/v1/connections/requests/incoming/accept") {
    state.requests = [];
    state.items.push({ id: "accepted", member_a: "self", member_b: "new-person", kind: body.kind, own_history: body.history, peer_history: "full" });
  } else if (request.method === "PUT" && request.url === "/api/v1/connections/existing/kind") {
    if (state.failKind) { response.statusCode = 409; response.end('{"error":{"message":"Label update could not be saved."}}'); return; }
    state.items[0].kind = body.kind;
  } else if (!(request.method === "POST" && request.url === "/api/v1/connections/requests")) {
    response.statusCode = 404; response.end('{"error":{"message":"Unexpected test request."}}'); return;
  }
  response.end('{"ok":true}');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      const page = await context.newPage();
      const load = async () => { await page.goto(origin); await page.getByText("Your label: Family", { exact: true }).waitFor(); };
      reset(); await load();
      const incoming = page.locator(".connection-request-row");
      assert.equal(await incoming.getByLabel("Your label", { exact: true }).inputValue(), "friend");
      assert.equal(await incoming.getByLabel("Share your posts", { exact: true }).inputValue(), "full");
      assert.equal(await incoming.getByText(/Wants to connect as|agreed|proposed/i).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await incoming.getByRole("button", { name: "Accept connection request from @new_person" }).click();
      await page.getByText("Connected with @new_person.", { exact: true }).waitFor();
      assert.deepEqual(state.calls.at(-1), { method: "POST", path: "/api/v1/connections/requests/incoming/accept", body: { kind: "friend", history: "full" } });
      assert.equal(await page.evaluate(() => window.sharingChecks), 1);

      reset({ requests: [{ id: "incoming", sender: "new-person", recipient: "self", kind: "family", history: "full" }] }); await load();
      // Even an old server's sender label must not become the recipient's choice.
      assert.equal(await incoming.getByLabel("Your label", { exact: true }).inputValue(), "friend");
      await incoming.getByLabel("Your label", { exact: true }).selectOption("family");
      await incoming.getByLabel("Share your posts", { exact: true }).selectOption("future");
      await incoming.getByRole("button", { name: "Accept connection request from @new_person" }).click();
      await page.getByText("Connected with @new_person.", { exact: true }).waitFor();
      assert.deepEqual(state.calls.at(-1).body, { kind: "family", history: "future" });

      reset(); await load();
      const existing = page.locator(".member-row").filter({ has: page.getByRole("link", { name: /@person/ }) });
      await existing.locator("summary").click();
      await existing.getByRole("button", { name: "Label as friend", exact: true }).click();
      await page.getByText("Your label was updated.", { exact: true }).waitFor();
      assert.deepEqual(state.calls.at(-1), { method: "PUT", path: "/api/v1/connections/existing/kind", body: { kind: "friend" } });
      assert.equal(state.items[0].own_history, "future");
      assert.equal(await existing.getByText("Your label: Friend", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => window.sharingChecks), 1);
      await existing.getByRole("button", { name: "Label as family", exact: true }).click();
      await existing.getByText("Your label: Family", { exact: true }).waitFor();
      assert.deepEqual(state.calls.at(-1).body, { kind: "family" });
      assert.equal(await page.evaluate(() => window.sharingChecks), 2);

      reset({ failKind: true }); await load();
      await existing.locator("summary").click();
      await existing.getByRole("button", { name: "Label as friend", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Label update could not be saved." }).waitFor();
      assert.equal(await existing.getByText("Your label: Family", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => window.sharingChecks), 0);

      reset(); await load();
      const send = page.locator(".connection-search");
      await send.getByLabel("Their exact handle").fill("@New_Person");
      await send.getByLabel("Your label", { exact: true }).selectOption("family");
      await send.getByLabel("Share your posts", { exact: true }).selectOption("future");
      await send.getByRole("button", { name: "Send request" }).click();
      await page.getByText("Connection request sent.", { exact: true }).waitFor();
      assert.deepEqual(state.calls.at(-1), { method: "POST", path: "/api/v1/connections/requests", body: { handle: "new_person", kind: "family", history: "future" } });

      reset(); state.items = Array.from({ length: 300 }, (_, index) => ({ id: `c${index}`, member_a: "self", member_b: `p${index}`, kind: "friend", own_history: "future" }));
      await page.goto(origin); await page.getByText("300 / 300", { exact: true }).waitFor();
      assert.equal(await send.getByRole("button", { name: "Send request" }).isDisabled(), true);
      assert.equal(await incoming.getByRole("button", { name: "Accept connection request from @new_person" }).isDisabled(), true);
      console.log(JSON.stringify({ browser: name, version: browser.version(), passed: true, scenarios: 6, mobileWidth: 390 }));
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
