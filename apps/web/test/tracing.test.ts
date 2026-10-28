import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTraceId, flushTraces, installTracing, markOnce, setTracingEnabled, traced, traceReport, tracingBuffers, tracingEnabled } from "../src/tracing";

/** Lets a test deliver Resource Timing entries to the collector. */
function observers() {
  const live = new Map<string, Set<(entries: PerformanceEntry[]) => void>>();
  class FakeObserver {
    private type = "";
    constructor(private readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void) {}
    private readonly deliver = (entries: PerformanceEntry[]) => this.callback({ getEntries: () => entries });
    observe(options: { type: string }) { this.type = options.type; (live.get(this.type) ?? live.set(this.type, new Set()).get(this.type)!).add(this.deliver); }
    disconnect() { live.get(this.type)?.delete(this.deliver); }
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
  return {
    emit: (type: string, entries: object[]) => live.get(type)?.forEach((deliver) => deliver(entries as PerformanceEntry[])),
    count: (type: string) => live.get(type)?.size ?? 0,
  };
}
function resourceEntry(url: string, startTime: number, responseStart: number, responseEnd: number, serverTiming: object[] = []) {
  return { name: url, initiatorType: "fetch", startTime, requestStart: startTime + 1, responseStart, responseEnd,
    duration: responseEnd - startTime, connectStart: 0, connectEnd: 0, transferSize: 1000, encodedBodySize: 900,
    nextHopProtocol: "h2", serverTiming };
}

function browser() {
  const store = new Map<string, string>();
  const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
  const events = new EventTarget();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal("location", new URL("https://porchday.org/app"));
  vi.stubGlobal("document", Object.assign(events, { visibilityState: "visible" }));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { fetch: upstream }));
  return { upstream, store };
}
const uploads = (upstream: ReturnType<typeof browser>["upstream"]) =>
  upstream.mock.calls.filter(([input]) => String(input) === "/api/v1/traces").map(([, init]) => JSON.parse(String(init!.body)));

beforeEach(() => setTracingEnabled(false));
afterEach(() => { setTracingEnabled(false); vi.unstubAllGlobals(); });

describe("performance tracing", () => {
  it("stays off, and leaves fetch untouched, unless the member opts in on this browser", async () => {
    const { upstream } = browser();
    installTracing();
    expect(tracingEnabled()).toBe(false);
    expect(window.fetch).toBe(upstream);
    expect(currentTraceId()).toBeNull();
  });

  it("adds traceparent only to this origin's API requests and uploads them as spans", async () => {
    const { upstream, store } = browser();
    setTracingEnabled(true);
    expect(store.get("porchday-performance-tracing")).toBe("on");
    const traceId = currentTraceId()!;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    await window.fetch("/api/v1/feed");
    await window.fetch("https://elsewhere.example/api/v1/feed");
    await window.fetch("/assets/app.js");
    const headers = upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get("traceparent"));
    expect(headers[0]).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(headers.slice(1)).toEqual([null, null]);
    markOnce("vault-ready");
    markOnce("vault-ready");
    await traced("decrypt", async () => 1);
    await expect(traced("photo decode", async () => { throw Error("bad jpeg"); })).rejects.toThrow("bad jpeg");
    await flushTraces(true);
    const [body] = uploads(upstream);
    expect(body).toMatchObject({ trace_id: traceId, page: "/app" });
    expect(body.spans.map((s: { kind: string; name: string }) => `${s.kind}:${s.name}`)).toEqual([
      "mark:vault-ready", "measure:decrypt", "measure:photo decode", "resource:GET /api/v1/feed",
    ]);
    expect(body.spans.find((s: { name: string }) => s.name === "photo decode").attrs).toEqual({ error: "bad jpeg" });
    expect(body.spans.at(-1).attrs).toEqual({ status: 200, headers_only: true });
    // The upload itself is never traced or re-uploaded.
    const uploadCall = upstream.mock.calls.find(([input]) => String(input) === "/api/v1/traces")!;
    expect(new Headers(uploadCall[1]!.headers).get("traceparent")).toBeNull();
    await flushTraces(true);
    expect(uploads(upstream)).toHaveLength(1);
  });

  it("stops uploading when the server has no trace storage, and restores fetch when turned off", async () => {
    const { upstream } = browser();
    upstream.mockImplementation(async (input) => new Response("{}", { status: String(input) === "/api/v1/traces" ? 404 : 200 }));
    setTracingEnabled(true);
    markOnce("a");
    await flushTraces(true);
    markOnce("b");
    await flushTraces(true);
    expect(uploads(upstream)).toHaveLength(1);
    setTracingEnabled(false);
    expect(window.fetch).toBe(upstream);
  });

  it("stops observing and releases buffers once the server reports no trace storage", async () => {
    const perf = observers();
    const { upstream } = browser();
    upstream.mockImplementation(async (input) => new Response("{}", { status: String(input) === "/api/v1/traces" ? 404 : 200 }));
    setTracingEnabled(true);
    expect(perf.count("resource")).toBe(1);
    markOnce("a");
    await flushTraces(true);
    // The reviewer's reproduction: 100 later entries must not be retained.
    perf.emit("resource", Array.from({ length: 100 }, (_, i) => resourceEntry(`https://porchday.org/assets/${i}.js`, i, i + 1, i + 2)));
    await window.fetch("/api/v1/feed");
    await flushTraces(true);
    expect(perf.count("resource")).toBe(0);
    expect(window.fetch).toBe(upstream);
    expect(tracingBuffers()).toEqual({ fetches: 0, resources: 0, pending: 0 });
    expect(currentTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("bounds buffers when uploads cannot drain them", async () => {
    const perf = observers();
    browser();
    setTracingEnabled(true);
    perf.emit("resource", Array.from({ length: 5_000 }, (_, i) => resourceEntry(`https://porchday.org/assets/${i}.js`, i, i + 1, i + 2)));
    expect(tracingBuffers()!.resources).toBe(2_000);
  });

  it("measures a request through its full body download and nests the server's spans", async () => {
    const perf = observers();
    const { upstream } = browser();
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(150);
    setTracingEnabled(true);
    await window.fetch("/api/v1/media/abc/bytes");
    // Headers at 150 ms, but the body finished at 2,100 ms.
    perf.emit("resource", [resourceEntry("https://porchday.org/api/v1/media/abc/bytes", 100, 150, 2_100, [
      { name: "pd-total", duration: 40, description: "" },
      { name: "pd-span", duration: 25, description: "r2_media_get@10" },
      { name: "pd-route", duration: 0, description: "/api/v1/media/:id/bytes" },
    ])]);
    vi.restoreAllMocks();
    await flushTraces(true);
    const [body] = uploads(upstream);
    const request = body.spans.find((s: { kind: string }) => s.kind === "resource");
    expect(request).toMatchObject({ name: "GET /api/v1/media/abc/bytes", start: 100, dur: 2_000 });
    expect(request.attrs).toMatchObject({ download: 1_950, route: "/api/v1/media/:id/bytes", server_total: 40 });
    expect(request.attrs.headers_only).toBeUndefined();
    expect(body.spans.filter((s: { parent?: number }) => s.parent === request.seq).map((s: { name: string }) => s.name)).toEqual(["r2_media_get", "server total"]);
  });

  it("labels a request without a timing entry as headers-only", async () => {
    const { upstream } = browser();
    setTracingEnabled(true);
    await window.fetch("/api/v1/feed");
    await flushTraces(true);
    expect(uploads(upstream)[0].spans.at(-1).attrs).toEqual({ status: 200, headers_only: true });
  });

  it("formats a nested waterfall for builder chat", () => {
    const text = traceReport({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", started_at: Date.UTC(2026, 9, 28), page: "/app", browser: "Chrome 141",
      connection: "4g", edge: "SIN", release: "44afbb8d-3133",
      spans: [
        { seq: 0, parent_seq: null, kind: "resource", name: "GET /api/v1/feed", start_ms: 120, duration_ms: 1450,
          attrs: { status: 200, edge: "SIN", server_total: 1210, count_db_conn_social: 1 } },
        { seq: 2, parent_seq: 0, kind: "server", name: "social_query", start_ms: 900, duration_ms: 340, attrs: null },
        { seq: 1, parent_seq: 0, kind: "server", name: "journal_check", start_ms: 240, duration_ms: 310, attrs: null },
      ],
    });
    expect(text.split("\n")).toEqual([
      "Porchday trace 4bf92f3577b34da6a3ce929d0e0e4736",
      "2026-10-28T00:00:00.000Z · /app · Chrome 141 · 4g · upload edge SIN · release 44afbb8d",
      "start_ms  dur_ms  span",
      "     120    1450  GET /api/v1/feed  [status=200 edge=SIN server_total=1210 db_conn_social=1]",
      "     240     310    ↳ journal_check",
      "     900     340    ↳ social_query",
    ]);
  });
});
