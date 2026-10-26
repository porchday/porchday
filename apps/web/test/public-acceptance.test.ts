import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AuthPage, Landing, StolenAccount, Policy } from "../src/Public";
afterEach(() => vi.unstubAllGlobals());
function locationFor(search = "", hash = "") {
  vi.stubGlobal("location", {
    origin: "https://porchday.test",
    pathname: "/join",
    search,
    hash,
  });
}
describe("public pilot acceptance contract", () => {
  it.each([
    ["", "#invite=fragment-invitation", "fragment-invitation"],
    ["?invite=legacy-invitation", "", "legacy-invitation"],
    ["?invite=legacy-invitation", "#invite=fragment-invitation", "fragment-invitation"],
  ])("prefills the invitation from signup links (%s, %s)", (search, hash, expected) => {
    locationFor(search, hash);
    const html = renderToStaticMarkup(
      createElement(AuthPage, { mode: "join", onSignedIn: () => {} }),
    );
    expect(html).toContain(`value="${expected}"`);
  });
  it("requires an invitation, adult attestation, rules consent, and a human operator without OAuth buttons", () => {
    locationFor();
    const html = renderToStaticMarkup(
      createElement(AuthPage, { mode: "join", onSignedIn: () => {} }),
    );
    expect(html).toContain("An invitation is required. You must be 18 or older to join.");
    expect(html).toContain("Invitation code");
    expect(html).toContain("I am at least 18 years old");
    expect(html).toContain("I’m a person operating my own account");
    expect(html).toMatch(/minlength="12"/i);
    expect(html).not.toMatch(
      /Continue with (Google|GitHub|Apple|Microsoft|Facebook)/,
    );
    expect((html.match(/type="checkbox" required=""/g) || []).length).toBe(2);
  });
  it("does not infer email-change completion from the shared two-step callback", () => {
    locationFor("?emailChanged=1");
    const html = renderToStaticMarkup(
      createElement(AuthPage, { mode: "login", onSignedIn: () => {} }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("approval at your current");
    expect(html).toContain("address and verification at the new one");
    expect(html).toContain("check your new inbox");
    expect(html).not.toContain("Your email change is complete");
    expect(html).not.toContain('class="alert success"');

    locationFor("?emailChanged=1&error=private-provider-detail");
    const failed = renderToStaticMarkup(
      createElement(AuthPage, { mode: "login", onSignedIn: () => {} }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("This email-change step could not be completed");
    expect(failed).not.toContain('role="status"');
    expect(failed).not.toContain('class="alert success"');
    expect(failed).not.toContain("private-provider-detail");
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
    expect(html).toContain("a simple social network");
    expect(html).toContain("No ads. No influencers. No algorithm.");
    expect(html).toContain("We’re building Porchday for nonprofit stewardship");
    expect(html).toContain("philanthropy");
    expect(html).toContain("By invitation only.");
    expect(html).not.toContain("friends &amp; family &amp; being yourself");
    expect(html).not.toContain("classic-status");
    expect(html).not.toContain("A little closer to your people.");
    expect(html).not.toContain("A private pilot.");
    expect(html).not.toContain("about this little website");
    expect(html).not.toContain("site-about");
    expect(html).toContain('Have an invitation? <a href="/join">create account</a>');
    const about = renderToStaticMarkup(
      createElement(Policy, { page: "about" }),
    );
    expect(about).toContain("still being established");
    expect(about).toContain("development repository is private");
    expect(about).toContain("Apache 2.0");
  });
});
