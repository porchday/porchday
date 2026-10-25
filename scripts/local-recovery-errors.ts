/** Real form requests against loopback only; all API responses are synthetic. */
import assert from "node:assert/strict";
import { chromium, type Page, type Route } from "playwright";

const target = new URL(process.argv[2] || "http://127.0.0.1:5173");
if (process.argv.length > 3 || target.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
  target.username || target.password || target.pathname !== "/" || target.search || target.hash)
  throw Error("LOOPBACK_ORIGIN_REQUIRED");
const tokenA = "a".repeat(64), tokenB = "b".repeat(64);
const password = "Synthetic local phrase 42!";
const success = { ok: true, signInRequired: true, encryptionRecoveryRequired: true };
const browser = await chromium.launch({ headless: true });
const unexpected: string[] = [];

async function fixture(respond: (route: Route) => Promise<void>) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== target.origin) { unexpected.push("EXTERNAL_REQUEST"); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname !== "/api/account-recovery/complete" || route.request().method() !== "POST") {
      unexpected.push("UNEXPECTED_API"); return route.fulfill({ status: 400, json: {} });
    }
    await respond(route);
  });
  await page.goto(`${target.origin}/recovery#restore=${tokenA}`);
  await page.getByLabel("New password", { exact: true }).waitFor();
  await page.waitForFunction(() => location.hash === "");
  return { context, page };
}
async function noPrivatePersistence(page: Page) {
  assert.equal(await page.evaluate(() => location.hash), "");
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert.ok(!stored.includes(tokenA) && !stored.includes(tokenB) && !stored.includes(password));
  const html = await page.content();
  assert.ok(!html.includes(tokenA) && !html.includes(tokenB) && !html.includes("private-provider-detail"));
}
async function settledForm(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return !!form && !form.querySelector<HTMLButtonElement>("button[type=submit], button")?.disabled;
  });
}
try {
  for (const [status, code, text] of [
    [400, "INVALID_OR_USED_LINK", "Open the newest restoration email"],
    [400, "INVALID_RECOVERY", "between 12 and 128 characters"],
    [403, "REVIEW_REQUIRED", "review needs to be confirmed again"],
    [409, "CONTACT_UNAVAILABLE", "verified safe contact address"],
    [429, "RATE_LIMITED", "Wait at least 15 minutes"],
    [500, "UNKNOWN", "We could not confirm whether"],
  ] as const) {
    let count = 0;
    const { context, page } = await fixture(async route => {
      count++;
      assert.deepEqual(route.request().postDataJSON(), { token: tokenA, newPassword: password });
      await route.fulfill({ status, json: { error: { code, message: "private-provider-detail" } } });
    });
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Restore my login access", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: text }).waitFor();
    await settledForm(page);
    assert.equal(await page.getByLabel("New password", { exact: true }).inputValue(), password);
    assert.equal(await page.getByRole("heading", { name: "Your login access is restored." }).count(), 0);
    await noPrivatePersistence(page);
    assert.equal(count, 1);
    if (code === "INVALID_OR_USED_LINK") {
      await page.getByRole("link", { name: "Resume your recovery case", exact: true }).click();
      await page.getByLabel("Case reference", { exact: true }).waitFor();
      assert.equal(await page.locator("input[type=password]").count(), 0);
      assert.equal(count, 1);
    }
    await context.close();
  }

  // A replacement fragment must be consumed in the same mounted document.
  // A late success or failure for the old link may not alter the new form.
  for (const oldStatus of [200, 400]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const sent: string[] = [];
    const { context, page } = await fixture(async route => {
      const body = route.request().postDataJSON(); sent.push(body.token);
      if (sent.length === 1) {
        started(); await gate;
        await route.fulfill({ status: oldStatus, json: oldStatus === 200 ? success : { error: { code: "INVALID_OR_USED_LINK" } } });
      } else await route.fulfill({ status: 200, json: success });
    });
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Restore my login access", exact: true }).click();
    await start;
    await page.evaluate(({ next, historyNavigation }) => {
      if (historyNavigation) {
        history.pushState({}, "", `#restore=${next}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else location.hash = `restore=${next}`;
    }, { next: tokenB, historyNavigation: oldStatus === 400 });
    await page.waitForFunction(() => location.hash === "" && document.querySelector<HTMLInputElement>("input[type=password]")?.value === "");
    await page.getByRole("alert").filter({ hasText: "A previous request is still pending" }).waitFor();
    assert.equal(await page.locator("form button").isDisabled(), true);
    await page.getByLabel("New password", { exact: true }).fill(password);
    // Even programmatic submission cannot bypass the outstanding request guard.
    await page.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
    assert.equal(sent.length, 1);
    release();
    await settledForm(page);
    assert.equal(await page.getByRole("heading", { name: "Your login access is restored." }).count(), 0);
    assert.equal(await page.getByLabel("New password", { exact: true }).inputValue(), password);
    assert.ok(!(await page.locator("#main-content").innerText()).includes("Open the newest restoration email"));
    await noPrivatePersistence(page);
    await page.getByRole("button", { name: "Restore my login access", exact: true }).click();
    await page.getByRole("heading", { name: "Your login access is restored." }).waitFor();
    assert.deepEqual(sent, [tokenA, tokenB]);
    assert.equal(await page.locator("input[type=password]").count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    await noPrivatePersistence(page);
    await context.close();
  }

  // No success cue for a different 2xx status or an incomplete 200 payload.
  for (const [status, body] of [[201, success], [200, { ok: true }]] as const) {
    const { context, page } = await fixture(route => route.fulfill({ status, json: body }));
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Restore my login access", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "We could not confirm whether" }).waitFor();
    assert.equal(await page.getByLabel("New password", { exact: true }).inputValue(), password);
    assert.equal(await page.getByRole("heading", { name: "Your login access is restored." }).count(), 0);
    await context.close();
  }
  assert.deepEqual(unexpected, []);
  console.log("Local recovery form: contextual errors, draft retention, strict success, and replacement-link isolation passed.");
} finally {
  await browser.close();
}
