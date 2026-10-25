/** Loopback UI acceptance; every API response and identity is synthetic. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = new URL(process.argv[2] || "http://127.0.0.1:5173");
if (process.argv.length > 3 || target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw Error("LOOPBACK_ORIGIN_REQUIRED");
const caseId = "a1000000-0000-4000-8000-000000000001";
const row = { id: caseId, state: "hold", created_at: "2026-01-01T12:00:00Z" };
const detail = { ...row, account_reference: "synthetic_member", safe_email: "synthetic@example.test", contact_verified_at: row.created_at, reviews: [{ decision: "restore", evidence_reference: "Synthetic prior corroboration" }], evidence: [] };
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of ["queued", "refresh-failed", "unknown", "access-lost"] as const) {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    let posts = 0; const unexpected: string[] = [];
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== target.origin) { unexpected.push("EXTERNAL_REQUEST"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/staff/identity") return route.fulfill({ json: { subject: "synthetic-staff", email: "staff@example.test", roles: ["recovery"] } });
      if (url.pathname === "/api/staff/recovery/cases") return route.fulfill({ json: { cases: Array.from({ length: 12 }, (_, i) => ({ ...row, id: i === 0 ? caseId : `a1000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` })) } });
      if (url.pathname === "/api/staff/recovery/cases/" + caseId) return route.fulfill(scenario === "refresh-failed" && posts ? { status: 503, json: {} } : { json: detail });
      if (url.pathname === `/api/staff/recovery/cases/${caseId}/review` && route.request().method() === "POST") {
        posts++; assert.deepEqual(route.request().postDataJSON(), { decision: "restore", evidenceReference: "Synthetic corroborating reference", reason: "Synthetic reviewed reissue explanation" });
        return route.fulfill(scenario === "unknown" ? { status: 503, json: { error: { code: "PRIVACY_CHECKPOINT_REQUIRED" } } } : scenario === "access-lost" ? { status: 401, json: { error: { code: "STAFF_AUTH_REQUIRED" } } } : { json: { ok: true, approvals: 2, restoreLinkQueued: true } });
      }
      unexpected.push("UNEXPECTED_API"); return route.fulfill({ status: 400, json: {} });
    });
    await page.goto(target.origin + "/staff");
    await page.getByRole("button", { name: new RegExp("Account recovery case " + caseId) }).click();
    const button = page.getByRole("button", { name: "Record review decision", exact: true });
    const reference = page.getByRole("textbox", { name: "Corroborating evidence reference", exact: true });
    const reason = page.getByRole("textbox", { name: "Reason for this decision", exact: true });
    assert.equal(await page.getByRole("combobox", { name: "Review action", exact: true }).inputValue(), "hold");
    await button.click();
    await page.getByRole("alert").filter({ hasText: "between 10 and 500" }).waitFor();
    assert.equal(await reference.evaluate(element => document.activeElement === element), true); assert.equal(posts, 0);
    await reference.fill("Synthetic corroborating reference"); await reason.fill("   short   ");
    await button.click(); await page.getByRole("alert").filter({ hasText: "between 10 and 1,000" }).waitFor();
    assert.equal(await reason.evaluate(element => document.activeElement === element), true); assert.equal(posts, 0);
    await reason.fill("Synthetic reviewed reissue explanation");
    await page.getByRole("combobox", { name: "Review action", exact: true }).selectOption("restore");
    await button.focus(); await page.keyboard.press("Enter");
    if (scenario === "access-lost") {
      await page.getByRole("alert").filter({ hasText: "Staff access could not be verified" }).waitFor();
      assert.equal(await button.count(), 0);
    } else {
      const feedback = page.locator('[aria-label="Review decision feedback"]');
      await feedback.locator(scenario === "unknown" ? '[role="alert"]' : '[role="status"]').waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Review decision feedback");
      const text = await feedback.innerText();
      if (scenario === "unknown") { assert.match(text, /could not confirm/); assert.doesNotMatch(text, /email was queued/); }
      else { assert.match(text, /2 distinct authorized approvals/); assert.match(text, /queued; delivery is not yet confirmed/); assert.match(text, /replaces earlier restoration links/); assert.match(text, /30 minutes/); }
      if (scenario === "refresh-failed") assert.match(text, /decision was recorded, but the updated case could not be loaded/);
      assert.equal(await reference.inputValue(), "Synthetic corroborating reference");
      const bounds = await feedback.boundingBox(); assert.ok(bounds && bounds.y >= 0 && bounds.y < 812);
    }
    assert.equal(posts, 1); assert.deepEqual(unexpected, []);
    await context.close();
  }
  console.log("Local staff review: field guidance, deliberate action, visible queued/unconfirmed feedback, refresh preservation and lost-access notice passed.");
} finally { await browser.close(); }
