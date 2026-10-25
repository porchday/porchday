import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const stagingOrigin = "https://staging.porchday.com";
export class SmokeError extends Error {}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new SmokeError(code);
}

/** Never follow provider redirects with an authenticated cookie or a token. */
export function target(path: string, origin = stagingOrigin): URL {
  check(origin === stagingOrigin, "STAGING_ORIGIN_REQUIRED");
  const url = new URL(path, origin);
  check(
    url.origin === origin && !url.username && !url.password && !url.hash,
    "SAME_ORIGIN_REQUIRED",
  );
  return url;
}

export function verificationTarget(value: string): string {
  const url = target(value);
  check(
    url.pathname === "/api/auth/verify-email" &&
      !!url.searchParams.get("token"),
    "EMAIL_VERIFICATION_LINK_REQUIRED",
  );
  const callback = url.searchParams.get("callbackURL");
  if (callback)
    check(
      target(callback).pathname === "/login",
      "VERIFICATION_CALLBACK_INVALID",
    );
  return url.pathname + url.search;
}

export function privatePath(path: string): string {
  const root = resolve("artifacts/private/hosted-smoke");
  const result = resolve(path);
  check(result.startsWith(root + sep), "PRIVATE_STATE_DIRECTORY_REQUIRED");
  return result;
}

async function protectedDirectory(path: string) {
  const directories: string[] = [];
  let directory = dirname(path);
  const workspace = resolve(".");
  const boundary = resolve("artifacts/private/hosted-smoke");
  while (directory !== workspace) {
    check(
      directory.startsWith(workspace + sep),
      "PRIVATE_STATE_DIRECTORY_REQUIRED",
    );
    directories.unshift(directory);
    directory = dirname(directory);
  }
  for (const directory of directories) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    check(
      info.isDirectory() && !info.isSymbolicLink(),
      "PRIVATE_DIRECTORY_PERMISSIONS_REQUIRED",
    );
    if (directory === boundary || directory.startsWith(boundary + sep))
      check(
        (info.mode & 0o077) === 0,
        "PRIVATE_DIRECTORY_PERMISSIONS_REQUIRED",
      );
  }
}

export async function readPrivate<T>(path: string): Promise<T> {
  path = privatePath(path);
  await protectedDirectory(path);
  const info = await lstat(path);
  check(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.size < 1_000_000,
    "PRIVATE_FILE_PERMISSIONS_REQUIRED",
  );
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writePrivate(
  path: string,
  value: unknown,
  exclusive = false,
) {
  path = privatePath(path);
  await protectedDirectory(path);
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = path + ".next";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/** This jar is intentionally memory-only. It supports the app's host-only / cookies. */
export class SmokeClient {
  private cookies = new Map<string, string>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  cookieHeader() {
    return [...this.cookies]
      .map(([name, value]) => name + "=" + value)
      .join("; ");
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    cookieOverride?: string,
  ): Promise<Response> {
    const url = target(path);
    const cookies = cookieOverride ?? this.cookieHeader();
    const response = await this.fetcher(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Origin: stagingOrigin,
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body === undefined
          ? {}
          : {
              "Content-Type":
                body instanceof Uint8Array
                  ? "application/octet-stream"
                  : "application/json",
            }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? new Uint8Array(body).buffer
            : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const separator = pair.indexOf("=");
      check(separator > 0, "COOKIE_INVALID");
      const name = pair.slice(0, separator),
        value = pair.slice(separator + 1);
      check(
        /^(?:__Secure-)?better-auth\.[a-z_-]+$/.test(name),
        "UNEXPECTED_COOKIE",
      );
      check(
        attributes.some((a) => a.trim().toLowerCase() === "secure") &&
          attributes.some((a) => a.trim().toLowerCase() === "httponly"),
        "COOKIE_PROTECTION_MISSING",
      );
      check(
        attributes.some((a) => /^\s*samesite=(lax|strict)\s*$/i.test(a)),
        "COOKIE_SAMESITE_MISSING",
      );
      if (!value || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (url.pathname.startsWith("/api/"))
      check(
        response.headers.get("cache-control")?.includes("no-store"),
        "PRIVATE_RESPONSE_CACHEABLE",
      );
    return response;
  }
  async json<T = Record<string, any>>(
    path: string,
    method = "GET",
    body?: unknown,
    expected = 200,
  ): Promise<T> {
    const response = await this.request(path, method, body);
    check(response.status === expected, "HTTP_STATUS_" + response.status);
    return response.json() as Promise<T>;
  }
}
