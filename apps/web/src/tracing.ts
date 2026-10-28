/** Opt-in, first-party performance tracing (docs/performance-tracing.md).
 * Off unless the member turns it on for this browser in Settings → My data.
 * One trace covers one page load. The browser adds a `traceparent` header to
 * its own API requests; the Worker answers with its server spans in
 * `Server-Timing`; this module nests those under each request and uploads
 * batches to /api/v1/traces. Nothing is sent to any third party.
 */
const KEY = "porchday-performance-tracing";
const UPLOAD = "/api/v1/traces";
// Each upload passes the normal member checks, which use application
// database connections, so uploads stay infrequent.
const FLUSH_MS = 60_000;
// A tab that cannot upload (signed out, offline) must not grow without bound.
const MAX_BUFFERED = 2_000;
const MAX_BATCH = 200;
const MAX_BATCH_BYTES = 56 * 1024; // Keepalive requests share a 64 KB budget.

type Attrs = Record<string, string | number | boolean>;
export type TraceSpan = {
  seq: number;
  parent?: number | null;
  kind: "navigation" | "resource" | "server" | "mark" | "measure" | "paint" | "longtask" | "error";
  name: string;
  start: number;
  dur: number;
  attrs?: Attrs;
};
type FetchRecord = { method: string; url: string; start: number; end: number; status?: number; error?: string };

let state: {
  traceId: string;
  seq: number;
  pending: TraceSpan[];
  fetches: FetchRecord[];
  resources: PerformanceResourceTiming[];
  sentNavigation: boolean;
  unavailable: boolean;
  timer?: ReturnType<typeof setInterval>;
  observers: PerformanceObserver[];
  originalFetch?: typeof fetch;
} | null = null;
const marked = new Set<string>();

export function tracingEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}
export function setTracingEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {}
  if (on) installTracing();
  else uninstallTracing();
}
export function currentTraceId(): string | null {
  return state?.traceId ?? null;
}

function hex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
}
function sameOriginApi(input: RequestInfo | URL): URL | null {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return null;
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/health") return null;
    return url.pathname === UPLOAD ? null : url;
  } catch {
    return null;
  }
}
function push(span: Omit<TraceSpan, "seq">): number {
  if (!state || state.unavailable || state.pending.length >= MAX_BUFFERED) return -1;
  const seq = state.seq++;
  state.pending.push({ ...span, seq, start: round(span.start), dur: round(Math.max(0, span.dur)) });
  return seq;
}
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
function path(url: string): string {
  try {
    return new URL(url, location.href).pathname.slice(0, 280);
  } catch {
    return "unknown";
  }
}

export function installTracing(): void {
  if (state || !tracingEnabled() || typeof performance === "undefined") return;
  state = {
    traceId: hex(16), seq: 0, pending: [], fetches: [], resources: [],
    sentNavigation: false, unavailable: false, observers: [],
  };
  const original = window.fetch;
  state.originalFetch = original;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = state ? sameOriginApi(input) : null;
    if (!url || !state) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("traceparent", `00-${state.traceId}-${hex(8)}-01`);
    const record: FetchRecord = {
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      url: url.href, start: performance.now(), end: 0,
    };
    try {
      const response = await original(input, { ...init, headers });
      record.status = response.status;
      return response;
    } catch (error) {
      record.error = error instanceof Error ? error.name : "FetchError";
      throw error;
    } finally {
      record.end = performance.now();
      if (state && state.fetches.length < MAX_BUFFERED) state.fetches.push(record);
    }
  };
  try {
    performance.setResourceTimingBufferSize?.(1500);
  } catch {}
  observe("resource", (entry) => {
    if (state && state.resources.length < MAX_BUFFERED) state.resources.push(entry as PerformanceResourceTiming);
  });
  observe("longtask", (entry) => push({ kind: "longtask", name: "long task", start: entry.startTime, dur: entry.duration }));
  observe("largest-contentful-paint", (entry) =>
    push({ kind: "paint", name: "largest-contentful-paint", start: entry.startTime, dur: 0,
      attrs: { size: (entry as unknown as { size?: number }).size ?? 0 } }));
  observe("paint", (entry) => push({ kind: "paint", name: entry.name, start: entry.startTime, dur: 0 }));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  state.timer = setInterval(() => void flushTraces(), FLUSH_MS);
}
/** Stop all collection and release buffers. */
function stopCollection(): void {
  if (!state) return;
  if (state.originalFetch) window.fetch = state.originalFetch;
  for (const observer of state.observers) observer.disconnect();
  clearInterval(state.timer);
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  state.observers = [];
  state.fetches = [];
  state.resources = [];
  state.pending = [];
}
function uninstallTracing(): void {
  stopCollection();
  state = null;
}
/** Buffer sizes, for tests. */
export function tracingBuffers(): { fetches: number; resources: number; pending: number } | null {
  return state && { fetches: state.fetches.length, resources: state.resources.length, pending: state.pending.length };
}
function observe(type: string, handle: (entry: PerformanceEntry) => void): void {
  try {
    const observer = new PerformanceObserver((list) => list.getEntries().forEach(handle));
    observer.observe({ type, buffered: true });
    state?.observers.push(observer);
  } catch {
    // Unsupported entry types (for example long tasks in Safari) are skipped.
  }
}
const onError = (event: ErrorEvent) =>
  push({ kind: "error", name: "uncaught error", start: performance.now(), dur: 0,
    attrs: { error: String(event.message || "error").slice(0, 300) } });
const onRejection = (event: PromiseRejectionEvent) =>
  push({ kind: "error", name: "unhandled rejection", start: performance.now(), dur: 0,
    attrs: { error: String((event.reason as Error)?.message ?? event.reason ?? "rejection").slice(0, 300) } });
const onVisibility = () => {
  if (document.visibilityState === "hidden") void flushTraces();
};
const onPageHide = () => void flushTraces();

/** A one-time milestone such as "vault-ready" or "feed-loaded". */
export function markOnce(name: string): void {
  if (!state || marked.has(name)) return;
  marked.add(name);
  push({ kind: "mark", name, start: performance.now(), dur: 0 });
}
/** Time client work such as decryption. A no-op when tracing is off. */
export async function traced<T>(name: string, work: () => Promise<T>, attrs?: Attrs): Promise<T> {
  if (!state) return work();
  const start = performance.now();
  let error: string | undefined;
  try {
    return await work();
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 300) : "failed";
    throw failure;
  } finally {
    push({ kind: "measure", name, start, dur: performance.now() - start,
      attrs: error ? { ...attrs, error } : attrs });
  }
}

function navigationSpans(): void {
  if (!state || state.sentNavigation) return;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!nav || !nav.loadEventEnd) return;
  state.sentNavigation = true;
  push({
    kind: "navigation", name: "page load " + location.pathname, start: 0, dur: nav.loadEventEnd,
    attrs: {
      type: nav.type, protocol: nav.nextHopProtocol || "unknown",
      dns: round(nav.domainLookupEnd - nav.domainLookupStart),
      connect: round(nav.connectEnd - nav.connectStart),
      tls: nav.secureConnectionStart ? round(nav.connectEnd - nav.secureConnectionStart) : 0,
      wait: round(nav.responseStart - nav.requestStart),
      download: round(nav.responseEnd - nav.responseStart),
      dom_interactive: round(nav.domInteractive),
      dom_complete: round(nav.domComplete),
      transfer_bytes: nav.transferSize,
    },
  });
}
function resourceAttrs(entry: PerformanceResourceTiming): Attrs {
  const attrs: Attrs = {
    initiator: entry.initiatorType, protocol: entry.nextHopProtocol || "unknown",
    queue: round(Math.max(0, (entry.requestStart || entry.startTime) - entry.startTime)),
    wait: round(Math.max(0, entry.responseStart - entry.requestStart)),
    download: round(Math.max(0, entry.responseEnd - entry.responseStart)),
    transfer_bytes: entry.transferSize, body_bytes: entry.encodedBodySize,
  };
  if (entry.connectEnd > entry.connectStart) attrs.connect = round(entry.connectEnd - entry.connectStart);
  return attrs;
}
/** Nest the Worker's spans inside the time the browser waited for this response. */
function serverSpans(entry: PerformanceResourceTiming, parent: number, attrs: Attrs): void {
  const timings = entry.serverTiming ?? [];
  const total = timings.find((t) => t.name === "pd-total")?.duration ?? 0;
  const waited = Math.max(0, entry.responseStart - entry.requestStart);
  const origin = (entry.requestStart || entry.startTime) + Math.max(0, (waited - total) / 2);
  if (total) attrs.server_total = round(total);
  for (const timing of timings) {
    if (timing.name === "pd-edge") attrs.edge = timing.description;
    else if (timing.name === "pd-route") attrs.route = timing.description;
    else if (timing.name === "pd-release") attrs.release = timing.description;
    else if (timing.name === "pd-error") attrs.server_error = timing.description;
    else if (timing.name === "pd-count") {
      const [key, value] = timing.description.split("=");
      if (/^[a-z][a-z0-9_]{0,30}$/.test(key)) attrs["count_" + key] = Number(value) || 0;
    } else if (timing.name === "pd-span") {
      const at = timing.description.lastIndexOf("@");
      push({
        kind: "server", parent, name: timing.description.slice(0, at),
        start: origin + (Number(timing.description.slice(at + 1)) || 0), dur: timing.duration,
      });
    }
  }
  if (total) push({ kind: "server", parent, name: "server total", start: origin, dur: total });
}
function collect(final: boolean): void {
  if (!state) return;
  navigationSpans();
  const now = performance.now();
  const used = new Set<PerformanceResourceTiming>();
  const waiting: FetchRecord[] = [];
  for (const record of state.fetches) {
    const entry = state.resources.find((r) => !used.has(r) && r.name === record.url && Math.abs(r.startTime - record.start) < 50);
    // Resource entries can trail the fetch promise slightly; give them one cycle.
    if (!entry && !final && now - record.end < 2_000) { waiting.push(record); continue; }
    if (entry) used.add(entry);
    const attrs: Attrs = entry ? resourceAttrs(entry) : {};
    if (record.status !== undefined) attrs.status = record.status;
    if (record.error) attrs.error = record.error;
    // fetch() resolves when headers arrive. Resource Timing's responseEnd
    // includes the body download, so prefer it when the entry is available.
    const start = entry ? Math.min(entry.startTime, record.start) : record.start;
    const end = entry?.responseEnd ? Math.max(entry.responseEnd, record.end) : record.end;
    if (!entry || !entry.responseEnd) attrs.headers_only = true;
    const seq = push({ kind: "resource", name: `${record.method} ${path(record.url)}`, start, dur: end - start, attrs });
    if (entry && seq >= 0) serverSpans(entry, seq, attrs);
  }
  state.fetches = waiting;
  const remaining: PerformanceResourceTiming[] = [];
  for (const entry of state.resources) {
    if (used.has(entry) || path(entry.name) === UPLOAD) continue;
    // An API entry normally pairs with its fetch record; wait briefly for it.
    if (sameOriginApi(entry.name) && !final && now - entry.responseEnd < 4_000) { remaining.push(entry); continue; }
    const attrs = resourceAttrs(entry);
    const seq = push({ kind: "resource", name: `${entry.initiatorType} ${path(entry.name)}`, start: entry.startTime, dur: entry.duration, attrs });
    if (seq >= 0) serverSpans(entry, seq, attrs);
  }
  state.resources = remaining;
}
function browser(): string {
  const ua = navigator.userAgent;
  const match = /(Edg|Firefox|Chrome)\/(\d+)/.exec(ua) || /Version\/(\d+).*Safari/.exec(ua);
  if (!match) return "other";
  return match.length === 3 ? `${match[1] === "Edg" ? "Edge" : match[1]} ${match[2]}` : `Safari ${match[1]}`;
}

/** Upload everything collected so far. Called on a timer, when the page is
 * hidden, and from Settings → "Send now". */
export async function flushTraces(final = document.visibilityState === "hidden"): Promise<void> {
  if (!state || state.unavailable) return;
  collect(final);
  const spans = state.pending.splice(0);
  const send = state.originalFetch ?? fetch;
  const meta = {
    trace_id: state.traceId, started_at: Math.round(performance.timeOrigin), page: location.pathname.slice(0, 200),
    browser: browser(),
    connection: (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType?.slice(0, 20),
  };
  while (spans.length && state) {
    const batch = spans.splice(0, MAX_BATCH);
    let body = JSON.stringify({ ...meta, spans: batch });
    while (body.length > MAX_BATCH_BYTES && batch.length > 1) {
      spans.unshift(...batch.splice(Math.ceil(batch.length / 2)));
      body = JSON.stringify({ ...meta, spans: batch });
    }
    try {
      const response = await send(UPLOAD, {
        method: "POST", body, keepalive: true, credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      });
      if (response.status === 404 && state) {
        // No trace storage on this server: stop collecting for this page.
        state.unavailable = true;
        stopCollection();
        return;
      }
      if (!response.ok) return; // Signed out or unavailable: drop, never retry.
    } catch {
      return;
    }
  }
}

/** Plain-text waterfall for builder chat. */
export function traceReport(trace: {
  trace_id: string; started_at: number; page: string; browser?: string | null; connection?: string | null;
  edge?: string | null; release?: string | null;
  spans: { seq: number; parent_seq: number | null; kind: string; name: string; start_ms: number; duration_ms: number; attrs: Attrs | null }[];
}): string {
  const lines = [
    `Porchday trace ${trace.trace_id}`,
    `${new Date(trace.started_at).toISOString()} · ${trace.page} · ${trace.browser ?? "?"} · ${trace.connection ?? "?"} · upload edge ${trace.edge ?? "?"} · release ${trace.release?.slice(0, 8) ?? "?"}`,
    "start_ms  dur_ms  span",
  ];
  const children = new Map<number, typeof trace.spans>();
  for (const span of trace.spans)
    if (span.parent_seq !== null) children.set(span.parent_seq, [...(children.get(span.parent_seq) ?? []), span]);
  const describe = (attrs: Attrs | null) => {
    if (!attrs) return "";
    const keys = ["status", "edge", "route", "server_total", "wait", "download", "body_bytes", "server_error", "error"];
    const counts = Object.entries(attrs).filter(([key]) => key.startsWith("count_")).map(([key, value]) => `${key.slice(6)}=${value}`);
    const parts = keys.filter((key) => attrs[key] !== undefined && attrs[key] !== "").map((key) => `${key}=${attrs[key]}`);
    return parts.length || counts.length ? `  [${[...parts, ...counts].join(" ")}]` : "";
  };
  const line = (span: (typeof trace.spans)[number], depth: number) =>
    `${span.start_ms.toFixed(0).padStart(8)}  ${span.duration_ms.toFixed(0).padStart(6)}  ${"  ".repeat(depth)}${span.kind === "server" ? "↳ " : ""}${span.name}${describe(span.attrs)}`;
  for (const span of trace.spans) {
    if (span.parent_seq !== null) continue;
    lines.push(line(span, 0));
    for (const child of (children.get(span.seq) ?? []).sort((a, b) => a.start_ms - b.start_ms)) lines.push(line(child, 1));
  }
  return lines.join("\n");
}
