import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  check,
  diagnosticRoute,
  privatePath,
  readPrivate,
  SmokeClient,
  stagingOrigin,
  target,
  verificationTarget,
  writePrivate,
  latencyErrorCode,
} from "./hosted-smoke-support.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = "artifacts/private/hosted-smoke/test-" + randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directories.push(directory);
  return directory;
}
const cookie =
  "__Secure-better-auth.session_token=synthetic-only; Path=/; HttpOnly; Secure; SameSite=Lax";
const response = (headers: Record<string, string> = {}) =>
  new Response("{}", {
    headers: { "Cache-Control": "private, no-store", ...headers },
  });

describe("hosted smoke guardrails", () => {
  it("classifies failed latency responses using only bounded fixed codes, never content",()=>{
    const bytes=(value:string)=>new TextEncoder().encode(value).buffer;
    expect(latencyErrorCode(503,bytes(JSON.stringify({error:{code:'PRIVACY_CHECKPOINT_REQUIRED',message:'private content',details:'private token'}})))).toBe('PRIVACY_CHECKPOINT_REQUIRED');
    for(const body of [JSON.stringify({error:{code:'private-token'}}),JSON.stringify({error:{code:'__proto__'}}),'<html>private provider error</html>',JSON.stringify({error:{code:'FORBIDDEN'},private:'x'.repeat(8192)})])expect(latencyErrorCode(503,bytes(body))).toBe('UNCLASSIFIED');
    expect(latencyErrorCode(200,bytes('private decrypted-looking text should never be parsed'))).toBeUndefined();
  });
  it("cannot send credentials to production, another origin or URL credentials", () => {
    expect(() => target("/api/v1/me", "https://porchday.com")).toThrow(
      "STAGING_ORIGIN_REQUIRED",
    );
    for (const value of [
      "https://example.com/api",
      "//example.com/api",
      "https://x:y@staging.porchday.com/api",
      "/api#secret",
    ])
      expect(() => target(value)).toThrow("SAME_ORIGIN_REQUIRED");
    expect(target("/api/v1/me").href).toBe(stagingOrigin + "/api/v1/me");
    expect(
      diagnosticRoute(
        "/api/v1/posts/private-id/reactions/opaque-secret?token=secret",
      ),
    ).toBe("/api/v1/posts/:id/reactions/:id");
  });
  it("only consumes actual email-verification paths with same-origin login callbacks", () => {
    expect(
      verificationTarget(
        stagingOrigin +
          "/api/auth/verify-email?token=synthetic&callbackURL=%2Flogin%3Fverified%3D1",
      ),
    ).toContain("/api/auth/verify-email?");
    expect(() =>
      verificationTarget("/api/auth/reset-password?token=synthetic"),
    ).toThrow("EMAIL_VERIFICATION_LINK_REQUIRED");
    expect(() =>
      verificationTarget(
        "/api/auth/verify-email?token=synthetic&callbackURL=https%3A%2F%2Fexample.com",
      ),
    ).toThrow("SAME_ORIGIN_REQUIRED");
  });
  it("refuses public, symlinked or broadly readable state files", async () => {
    expect(() => privatePath("state.json")).toThrow(
      "PRIVATE_STATE_DIRECTORY_REQUIRED",
    );
    const dir = await fixture();
    await writeFile(dir + "/unsafe.json", "{}", { mode: 0o644 });
    await expect(readPrivate(dir + "/unsafe.json")).rejects.toThrow(
      "PRIVATE_FILE_PERMISSIONS_REQUIRED",
    );
    await writePrivate(
      dir + "/safe.json",
      { marker: "synthetic-private-state" },
      true,
    );
    expect(await readPrivate(dir + "/safe.json")).toEqual({
      marker: "synthetic-private-state",
    });
    await symlink("safe.json", dir + "/link.json");
    await expect(readPrivate(dir + "/link.json")).rejects.toThrow(
      "PRIVATE_FILE_PERMISSIONS_REQUIRED",
    );
    await symlink(".", dir + "/linked-directory");
    await expect(
      writePrivate(dir + "/linked-directory/escaped.json", {}),
    ).rejects.toThrow("PRIVATE_DIRECTORY_PERMISSIONS_REQUIRED");
    await chmod(dir, 0o755);
    await expect(readPrivate(dir + "/safe.json")).rejects.toThrow(
      "PRIVATE_DIRECTORY_PERMISSIONS_REQUIRED",
    );
  });
  it("does not overwrite an existing run and atomically persists protected updates", async () => {
    const dir = await fixture(),
      file = dir + "/state.json";
    await writePrivate(file, { step: 1 }, true);
    await expect(writePrivate(file, { step: 2 }, true)).rejects.toThrow();
    expect(await readPrivate(file)).toEqual({ step: 1 });
    await writePrivate(file, { step: 3 });
    expect(await readPrivate(file)).toEqual({ step: 3 });
  });
  it("uses only same-origin memory cookies, disables redirect following and honors revocation", async () => {
    const calls: RequestInit[] = [];
    const api = new SmokeClient(async (_url, init) => {
      calls.push(init!);
      return calls.length === 1
        ? response({ "Set-Cookie": cookie })
        : response({
            "Set-Cookie":
              cookie.replace("=synthetic-only", "=") + "; Max-Age=0",
          });
    });
    await api.request("/api/auth/sign-in/email", "POST", {
      password: "synthetic-only",
    });
    expect(api.cookieHeader()).toBe(
      "__Secure-better-auth.session_token=synthetic-only",
    );
    await api.request("/api/auth/sign-out", "POST", {});
    expect(api.cookieHeader()).toBe("");
    expect(calls[0].redirect).toBe("manual");
    expect((calls[1].headers as Record<string, string>).Cookie).toBe(
      "__Secure-better-auth.session_token=synthetic-only",
    );
  });
  it("rejects unsafe cookies and cacheable protected responses", async () => {
    const access = new SmokeClient(async () =>
      response({
        "Set-Cookie":
          "CF_AppSession=synthetic-edge-cookie; Secure; HttpOnly; SameSite=None",
      }),
    );
    await access.request("/api/staff/recovery/cases");
    expect(access.cookieHeader()).toBe("");
    const noCookieProtection = new SmokeClient(async () =>
      response({ "Set-Cookie": "better-auth.session_token=synthetic-only" }),
    );
    await expect(
      noCookieProtection.request("/api/auth/sign-in/email"),
    ).rejects.toThrow("COOKIE_PROTECTION_MISSING");
    const cacheable = new SmokeClient(async () => new Response("{}"));
    await expect(cacheable.request("/api/v1/feed")).rejects.toThrow(
      "PRIVATE_RESPONSE_CACHEABLE",
    );
    const missing = new SmokeClient(
      async () =>
        new Response("private body must not be printed", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        }),
    );
    await expect(missing.json("/api/v1/feed")).rejects.toThrow(
      "HTTP_STATUS_503",
    );
  });
  it("reports only normalized routes and allowlisted error codes", async () => {
    const api = new SmokeClient(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "FORBIDDEN", detail: "private-content" },
          }),
          { status: 403, headers: { "Cache-Control": "no-store" } },
        ),
    );
    await expect(
      api.json("/api/v1/posts/secret-id?token=private", "POST", {
        secret: "private",
      }),
    ).rejects.toMatchObject({
      message: "HTTP_STATUS_403",
      diagnostic: {
        route: "/api/v1/posts/:id",
        method: "POST",
        code: "FORBIDDEN",
      },
    });
    const untrusted = new SmokeClient(
      async () =>
        new Response(JSON.stringify({ error: { code: "private-content" } }), {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }),
    );
    await expect(
      untrusted.json("/api/v1/imports", "POST", {}),
    ).rejects.toMatchObject({
      message: "HTTP_STATUS_400",
      diagnostic: { route: "/api/v1/imports", method: "POST" },
    });
    try {
      await untrusted.json("/api/v1/imports");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("private-content");
    }
  });
  it("refuses remote mutations before loading any private input without --run", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/hosted-smoke.ts", "signup"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      phase: "signup",
      passed: false,
      code: "EXPLICIT_RUN_REQUIRED",
    });
    expect(() => check(false, "FIXED_CODE")).toThrow("FIXED_CODE");
  });
});
