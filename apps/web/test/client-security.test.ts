import { describe, it, expect, vi, afterEach } from "vitest";
import { deadline, unexpired, ApiError, localDate } from "../src/api";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ExpiryWarning } from "../src/Social";
import { Button } from "../src/ui";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("client expiration and sharing semantics", () => {
  it("inherits an absolute deadline instead of restarting a duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T17:00:00Z"));
    const parent = "2026-10-25T17:30:00.000Z";
    expect(deadline("inherit", parent)).toBe(parent);
    expect(deadline("3600", parent)).toBe(parent);
    expect(deadline("900", parent)).toBe("2026-10-25T17:15:00.000Z");
  });
  it("allows custom shorter times but never broadens a bounded deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T17:00:00Z"));
    const parent = "2026-10-25T17:30:00.000Z";
    expect(deadline("custom:2026-10-25T17:05:00.000Z", parent)).toBe(
      "2026-10-25T17:05:00.000Z",
    );
    expect(deadline("custom:2026-10-26T17:05:00.000Z", parent)).toBe(parent);
    expect(deadline("", null)).toBeNull();
  });
  it("removes a loaded item at its effective ancestor deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T17:30:00Z"));
    expect(
      unexpired({
        expires_at: "2026-10-26T00:00:00.000Z",
        effective_expires_at: "2026-10-25T17:30:00.000Z",
      } as any),
    ).toBe(false);
    expect(unexpired({ expires_at: null } as any)).toBe(true);
  });
  it("warns about inherited reply expiry with the actual deadline and shorter option", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T17:00:00Z"));
    const html = renderToStaticMarkup(
      createElement(ExpiryWarning, {
        expiry: "2026-10-25T17:30:00.000Z",
        reply: true,
        fromPost: true,
      }),
    );
    expect(html).toContain("reply");
    expect(html).toContain("deleted with the");
    expect(html).toContain("30 minutes remaining");
    expect(html).toContain("You can make its timeout shorter");
    expect(html).toContain("inherited from the original post");
  });
  it("explains reauthentication and changed audience without retrying silently", () => {
    expect(
      new ApiError(403, { error: { code: "RECENT_AUTH_REQUIRED" } }).message,
    ).toContain("sign out and sign in again");
    expect(
      new ApiError(409, { error: { code: "AUDIENCE_CHANGED" } }).message,
    ).toContain("Review the audience");
  });
});
describe("client interaction safety", () => {
  it("keeps a busy submit disabled even when its validity flag says enabled", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { busy: true, disabled: false }, "Submit"),
    );
    expect(html).toContain("disabled=");
    expect(html).toContain("Working");
  });
  it("changes display timezone without changing the inherited instant", () => {
    vi.stubGlobal("localStorage", { getItem: () => "Pacific/Honolulu" });
    const instant = "2026-10-25T17:30:00.000Z";
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Pacific/Honolulu",
    }).format(new Date(instant));
    expect(localDate(instant)).toBe(expected);
    expect(deadline("inherit", instant)).toBe(instant);
  });
});
describe("PWA privacy boundaries", () => {
  it("uses a protected start URL and real raster install icons", () => {
    const manifest = JSON.parse(
      readFileSync("apps/web/public/manifest.webmanifest", "utf8"),
    );
    expect(manifest.start_url).toBe("/app");
    expect(manifest.display).toBe("standalone");
    for (const icon of manifest.icons) {
      const file = readFileSync("apps/web/public" + icon.src);
      expect([...file.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
    }
  });
  it("never intercepts private API fetches and keeps push generic", async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const notify = vi.fn().mockResolvedValue(undefined);
    const skipWaiting = vi.fn();
    runInNewContext(readFileSync("apps/web/public/sw.js", "utf8"), {
      URL,
      location: { origin: "https://porchday.test" },
      self: {
        addEventListener: (name: string, handler: (event: any) => void) => {
          handlers[name] = handler;
        },
        registration: { showNotification: notify },
        skipWaiting,
      },
    });
    for (const path of [
      "/api/v1/feed",
      "/api/v1/media/private/bytes",
      "/api/auth/get-session",
    ]) {
      const respondWith = vi.fn();
      handlers.fetch({
        request: { url: "https://porchday.test" + path, method: "GET" },
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const postResponse = vi.fn();
    handlers.fetch({
      request: { url: "https://porchday.test/assets/a.js", method: "POST" },
      respondWith: postResponse,
    });
    expect(postResponse).not.toHaveBeenCalled();
    const data = {
      text: vi.fn(() => "PRIVATE CONTENT"),
      json: vi.fn(() => ({ body: "PRIVATE CONTENT" })),
    };
    let push: Promise<void> | undefined;
    handlers.push({
      data,
      waitUntil: (promise: Promise<void>) => {
        push = promise;
      },
    });
    await push;
    expect(notify).toHaveBeenCalledWith(
      "Porchday",
      expect.objectContaining({
        body: "You have a new update.",
        data: { url: "/app" },
      }),
    );
    expect(data.text).not.toHaveBeenCalled();
    expect(data.json).not.toHaveBeenCalled();
    handlers.message({ data: "something else" });
    expect(skipWaiting).not.toHaveBeenCalled();
    handlers.message({ data: "ACTIVATE_UPDATE" });
    expect(skipWaiting).toHaveBeenCalledOnce();
  });
});
