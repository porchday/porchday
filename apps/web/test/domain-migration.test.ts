import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegacyDomainNotice, PreviousDomainUnlockHint } from "../src/DomainMigration";
import { needsDomainNavigation } from "../src/domain-navigation";
import { navigate } from "../src/ui";
afterEach(() => vi.unstubAllGlobals());

describe("domain migration guidance", () => {
  it("keeps the legacy tab open and explains how to retain access to encrypted history", () => {
    const html = renderToStaticMarkup(createElement(LegacyDomainNotice, { origin: "https://porchday.com", path: "/app/settings/security" }));
    expect(html).toContain('href="https://porchday.org/app" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("saved encryption recovery secret");
    expect(html).toContain("Keep this browser’s data and the old installed app");
    expect(html).toContain("separate app");
    expect(html).not.toContain("?token=");
  });
  it("shows guidance only for the exact legacy account origin, without affecting staging or new accounts", () => {
    for (const origin of ["https://porchday.org", "https://staging.porchday.com", "https://porchday.com.evil.example", "http://porchday.com", "https://porchday.com:444"]) {
      expect(renderToStaticMarkup(createElement(LegacyDomainNotice, { origin, path: "/login" }))).toBe("");
    }
    for (const path of ["/", "/join", "/about", "/staff", "/application", "/api/v1/me"]) {
      expect(renderToStaticMarkup(createElement(LegacyDomainNotice, { origin: "https://porchday.com", path }))).toBe("");
    }
  });
  it("offers a fixed old-origin recovery link without copying route tokens or opening a signing channel", () => {
    const html = renderToStaticMarkup(createElement(PreviousDomainUnlockHint, { origin: "https://porchday.org" }));
    expect(html).toContain('href="https://porchday.com/app" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("original browser");
    expect(html).toContain("until your history opens here");
    expect(html).not.toContain("password reset");
    for (const origin of ["https://porchday.com", "https://staging.porchday.com", "https://porchday.org.evil.example"]) {
      expect(renderToStaticMarkup(createElement(PreviousDomainUnlockHint, { origin }))).toBe("");
    }
  });
});

describe("explicit navigation from the legacy site", () => {
  it("uses the server redirect for public navigation and preserves query strings and fragments", () => {
    const assign = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal("location", { origin: "https://porchday.com", href: "https://porchday.com/login", assign });
    vi.stubGlobal("history", { pushState });
    navigate("/join?source=invitation#invite=synthetic-private-code");
    expect(assign).toHaveBeenCalledWith("https://porchday.com/join?source=invitation#invite=synthetic-private-code");
    expect(pushState).not.toHaveBeenCalled();
    navigate("/");
    expect(assign).toHaveBeenLastCalledWith("https://porchday.com/");
  });
  it("does not redirect private, recovery or unknown paths, staging, or unrelated origins", () => {
    for (const path of ["/app", "/app/post/id", "/login", "/reset?token=synthetic", "/recovery", "/staff", "/unknown", "/join/extra", "/app-shell.html"]) {
      expect(needsDomainNavigation(new URL(path, "https://porchday.com"), "https://porchday.com")).toBe(false);
    }
    for (const origin of ["https://porchday.org", "https://staging.porchday.com", "https://porchday.com.evil.example", "http://porchday.com"]) {
      expect(needsDomainNavigation(new URL("/", origin), origin)).toBe(false);
    }
    expect(needsDomainNavigation(new URL("https://other.example/join"), "https://porchday.com")).toBe(false);
  });
});
