import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../src/vault", () => ({ useVault: () => ({ member: { id: "author", handle: "author", status: "active" } }) }));
import { Connections, ConnectionKindChoice, HistoryChoice } from "../src/Community";

describe("directional connection history choices", () => {
  it("defaults a new request to explicitly labeled full history", () => {
    const html = renderToStaticMarkup(createElement(Connections));
    expect(html).toContain('<option value="full" selected="">Share full history (recommended)</option>');
    expect(html).toContain('<option value="future">Only share new posts</option>');
    expect(html).toContain("Share your posts");
    expect(html).toContain('<option value="friend" selected="">Friend</option>');
    expect(html).toContain("Your label");
    expect(html).toContain("Each person chooses their own label.");
    expect(html).not.toContain("agreed by both people");
  });
  it("shows an existing future-only choice without silently upgrading it", () => {
    const html = renderToStaticMarkup(createElement(HistoryChoice, { value: "future", onChange() {} }));
    expect(html).toContain('<option value="future" selected="">Only share new posts</option>');
    expect(html).not.toContain('<option value="full" selected="">');
  });
  it("keeps a person's family label selected without an agreement step", () => {
    const html = renderToStaticMarkup(createElement(ConnectionKindChoice, { value: "family", onChange() {} }));
    expect(html).toContain("Your label");
    expect(html).toContain('<option value="family" selected="">Family</option>');
    expect(html).not.toContain('<option value="friend" selected="">');
    expect(html).not.toMatch(/agree|propose/i);
  });
});
