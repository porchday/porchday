import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AuthPage, Landing, StolenAccount, Policy } from "../src/Public";
afterEach(() => vi.unstubAllGlobals());
function locationFor(search = "") {
  vi.stubGlobal("location", {
    origin: "https://porchday.test",
    pathname: "/join",
    search,
  });
}
describe("public pilot acceptance contract", () => {
  it("requires an invitation, adult attestation, rules consent, and a human operator without OAuth buttons", () => {
    locationFor();
    const html = renderToStaticMarkup(
      createElement(AuthPage, { mode: "join", onSignedIn: () => {} }),
    );
    expect(html).toContain("invitation-only pilot for adults");
    expect(html).toContain("Invitation code");
    expect(html).toContain("I am at least 18 years old");
    expect(html).toContain("I’m a person operating my own account");
    expect(html).toMatch(/minlength="12"/i);
    expect(html).not.toMatch(
      /Continue with (Google|GitHub|Apple|Microsoft|Facebook)/,
    );
    expect((html.match(/type="checkbox" required=""/g) || []).length).toBe(2);
  });
  it("keeps stolen-account reporting independent of login and matches the server description limit", () => {
    locationFor();
    const html = renderToStaticMarkup(createElement(StolenAccount));
    expect(html).toContain("even if its email or password was");
    expect(html).toContain("A safe email address");
    expect(html).toContain('name="description" maxLength="2000"');
    expect(html).toContain("Resume an existing recovery case");
    expect(html).not.toContain('type="password"');
  });
  it("states the core promises without claiming established nonprofit or public source status", () => {
    locationFor();
    const html = renderToStaticMarkup(createElement(Landing));
    expect(html).toContain("a late 90s style");
    expect(html).toContain("No ads. No influencers. No algorithm.");
    expect(html).toContain("We’re building Porchday for nonprofit stewardship");
    expect(html).toContain("philanthropy");
    const about = renderToStaticMarkup(
      createElement(Policy, { page: "about" }),
    );
    expect(about).toContain("still being established");
    expect(about).toContain("development repository is private");
    expect(about).toContain("Apache 2.0");
  });
});
