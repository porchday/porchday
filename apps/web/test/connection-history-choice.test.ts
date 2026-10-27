import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../src/vault", () => ({ useVault: () => ({ member: { id: "author", handle: "author", status: "active" } }) }));
import { Connections, HistoryChoice } from "../src/Community";

describe("directional connection history choices", () => {
  it("defaults a new request to explicitly labeled full history", () => {
    const html = renderToStaticMarkup(createElement(Connections));
    expect(html).toContain('<option value="full" selected="">Share full history (recommended)</option>');
    expect(html).toContain('<option value="future">Only share new posts</option>');
    expect(html).toContain("Share your posts");
  });
  it("shows an existing future-only choice without silently upgrading it", () => {
    const html = renderToStaticMarkup(createElement(HistoryChoice, { value: "future", onChange() {} }));
    expect(html).toContain('<option value="future" selected="">Only share new posts</option>');
    expect(html).not.toContain('<option value="full" selected="">');
  });
});
