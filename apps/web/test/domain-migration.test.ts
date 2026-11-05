import { canonicalPath } from "../src/routes";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalNavigation, needsDomainNavigation } from "../src/domain-navigation";
import { navigate } from "../src/ui";
afterEach(() => vi.unstubAllGlobals());
it("redirects legacy website routes while retaining paths, queries and fragments", () => {
  for (const path of ["/", "/app", "/app/albums", "/login", "/reset?token=synthetic", "/join#invite=synthetic", "//untrusted.example/path"]) {
    const url = new URL("https://porchday.com" + path);
    const target = canonicalNavigation(url)!;
    expect(new URL(target).origin).toBe("https://porchday.org");
    expect(target).toBe("https://porchday.org" + canonicalPath(url.pathname) + url.search + url.hash);
    expect(needsDomainNavigation(url, "https://porchday.com")).toBe(true);
  }
});
it("does not redirect canonical, staging or unrelated origins", () => {
  for (const origin of ["https://porchday.org", "https://staging.porchday.com", "https://porchday.com.evil.example", "http://porchday.com", "https://porchday.com:444"]) {
    expect(canonicalNavigation(new URL(origin + "/login"))).toBeNull();
    expect(needsDomainNavigation(new URL(origin + "/login"), origin)).toBe(false);
  }
});
it("bypasses the legacy SPA and service worker on explicit navigation", () => {
  const assign = vi.fn(), pushState = vi.fn();
  vi.stubGlobal("location", { origin: "https://porchday.com", href: "https://porchday.com/login", assign });
  vi.stubGlobal("history", { pushState });
  navigate("/join?source=invitation#invite=synthetic");
  expect(assign).toHaveBeenCalledWith("https://porchday.org/join?source=invitation#invite=synthetic");
  expect(pushState).not.toHaveBeenCalled();
});
