import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
vi.mock("../src/vault", () => ({
  useVault: () => ({
    member: { id: "member", handle: "reader", status: "restricted" },
    devices: [],
  }),
}));
import { Composer, Reactions } from "../src/Social";
import { Connections, Groups } from "../src/Community";
import { Settings } from "../src/Settings";

describe("restricted member controls", () => {
  it("does not offer a composer and disables reactions while keeping counts readable", () => {
    expect(
      renderToStaticMarkup(createElement(Composer, { onPosted() {} })),
    ).toBe("");
    const html = renderToStaticMarkup(
      createElement(Reactions, {
        target: { id: "post", envelope: { context: { kind: "post" } } } as any,
        payload: { text: "Readable" },
        reactions: [],
        reload: async () => {},
      }),
    );
    expect(html).toMatch(/disabled=""[^>]*aria-label="Add a reaction"/);
  });
  it("disables connection and group creation but preserves their views", () => {
    const connections = renderToStaticMarkup(createElement(Connections));
    expect(connections).toContain("Connections");
    expect(connections).toMatch(/<button[^>]*disabled=""[^>]*>Send request/);
    expect(connections).toMatch(/<button[^>]*disabled=""[^>]*>Send invitation/);
    const groups = renderToStaticMarkup(createElement(Groups));
    expect(groups).toMatch(/<button[^>]*disabled=""[^>]*>.*?New group/s);
  });
  it("explains profile restrictions while preserving data and safety navigation", () => {
    const html = renderToStaticMarkup(
      createElement(Settings, { tab: "profile", onLogout: async () => {} }),
    );
    expect(html).toContain("Profile changes are unavailable");
    expect(html).toContain("Privacy &amp; safety");
    expect(html).toContain("My data");
    expect(html).not.toContain("Save profile");
  });
});
