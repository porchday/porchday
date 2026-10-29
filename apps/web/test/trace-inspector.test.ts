import { describe, expect, it } from "vitest";
import { loadStats, milestones, seconds, shortLabel, ticks, waterfall, type StoredSpan, type StoredTrace } from "../src/trace-inspector";

const span = (seq: number, kind: string, name: string, start_ms: number, duration_ms: number, attrs: StoredSpan["attrs"] = null, parent_seq: number | null = null): StoredSpan =>
  ({ seq, parent_seq, kind, name, start_ms, duration_ms, attrs });
const photo = "GET /api/v1/media/4dc907ef-5906-47da-9214-84bbd9f5fb22/bytes";
const trace: StoredTrace = {
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", started_at: Date.UTC(2026, 9, 29), page: "/app",
  spans: [
    span(0, "resource", "GET /api/v1/feed", 200, 1_000, { status: 200, queue: 100, wait: 600, download: 300, server_total: 500 }),
    span(1, "server", "journal_check", 400, 200, null, 0),
    span(2, "server", "social_query", 650, 150, null, 0),
    span(3, "server", "server total", 350, 500, null, 0),
    span(4, "resource", photo, 1_300, 900, { status: 503, server_total: 50 }),
    span(5, "resource", "img /assets/logo.png", 50, 20, {}),
    span(6, "resource", "script /assets/cached.js", 10, 0, {}),
    span(7, "mark", "feed-loaded", 1_250, 0),
    span(8, "mark", "feed-loaded", 1_900, 0),
    span(9, "mark", "first-visible-photo", 2_400, 0),
    span(10, "mark", "something-else", 100, 0),
  ],
};

describe("trace inspector", () => {
  it("lists requests in start order, skipping zero-length cached assets, and splits each into its phases", () => {
    const { rows, start, end } = waterfall(trace, new Set());
    expect(rows.map((row) => row.span.seq)).toEqual([5, 0, 4]);
    expect(rows[1]).toMatchObject({ depth: 0, children: 2, api: true });
    expect(rows[1].segments).toEqual([
      { kind: "queue", start: 200, dur: 100 }, { kind: "wait", start: 300, dur: 600 }, { kind: "download", start: 900, dur: 300 },
    ]);
    // A failed request is one bar; a static asset is drawn but marked as not an API call.
    expect(rows[2].segments).toEqual([{ kind: "failed", start: 1_300, dur: 900 }]);
    expect(rows[0].api).toBe(false);
    // The axis covers the requests and the last milestone.
    expect([start, end]).toEqual([0, 2_400]);
  });

  it("shows an expanded request's server steps beneath it, without the server total", () => {
    const { rows } = waterfall(trace, new Set([0]));
    expect(rows.map((row) => `${row.depth}:${row.span.name}`)).toEqual([
      "0:img /assets/logo.png", "0:GET /api/v1/feed", "1:journal_check", "1:social_query", "0:" + photo,
    ]);
    expect(rows[2].segments).toEqual([{ kind: "step", start: 400, dur: 200 }]);
  });

  it("keeps only the first time each known milestone happened", () => {
    expect(milestones(trace)).toEqual([{ name: "feed-loaded", at: 1_250 }, { name: "first-visible-photo", at: 2_400 }]);
  });

  it("summarises one page load", () => {
    expect(loadStats(trace)).toEqual({ feedLoaded: 1_250, firstPhoto: 2_400, requests: 2, failed: 1, medianServer: 500 });
    expect(seconds(1_250)).toBe("1.25 s");
    expect(seconds(null)).toBe("—");
  });

  it("shortens IDs in labels and picks round axis ticks", () => {
    expect(shortLabel(photo)).toBe("GET /api/v1/media/…fb22/bytes");
    expect(ticks(0, 2_400, 6)).toEqual([0, 500, 1_000, 1_500, 2_000]);
    expect(ticks(0, 90, 4)).toEqual([0, 50]);
  });
});
