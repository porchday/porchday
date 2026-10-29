/** Pure layout for the performance trace inspector (TraceInspector.tsx).
 * Kept free of React and the DOM so the waterfall rules are tested directly. */
export type Attrs = Record<string, string | number | boolean>;
export type StoredSpan = {
  seq: number; parent_seq: number | null; kind: string; name: string;
  start_ms: number; duration_ms: number; attrs: Attrs | null;
};
export type StoredTrace = {
  trace_id: string; started_at: number; page: string; browser?: string | null; connection?: string | null;
  edge?: string | null; release?: string | null; spans: StoredSpan[];
};
export type Segment = { kind: "queue" | "wait" | "download" | "step" | "failed"; start: number; dur: number };
export type WaterfallRow = { span: StoredSpan; depth: 0 | 1; children: number; segments: Segment[]; api: boolean };

/** The browser milestones the inspector draws as vertical lines, in load order. */
export const MILESTONES = ["vault-ready", "feed-loaded", "first-decrypt", "first-readable-post", "photo-decoded", "first-visible-photo"];
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})/g;

export const isApiRequest = (span: StoredSpan) => span.kind === "resource" && /^(GET|POST|PUT|PATCH|DELETE) /.test(span.name);
export const failed = (span: StoredSpan) =>
  span.attrs?.error !== undefined || (typeof span.attrs?.status === "number" && span.attrs.status >= 400);
/** Long IDs are shortened to their last four characters for labels. */
export const shortLabel = (name: string) => name.replace(uuid, (_, tail: string) => "…" + tail.slice(-4));

export function milestones(trace: StoredTrace): { name: string; at: number }[] {
  const first = new Map<string, number>();
  for (const span of trace.spans)
    if ((span.kind === "mark" || span.kind === "paint") && MILESTONES.includes(span.name))
      first.set(span.name, Math.min(first.get(span.name) ?? Infinity, span.start_ms));
  return [...first].map(([name, at]) => ({ name, at })).sort((a, b) => a.at - b.at);
}

function segments(span: StoredSpan): Segment[] {
  const start = span.start_ms, dur = Math.max(0, span.duration_ms);
  if (span.kind === "server") return [{ kind: "step", start, dur }];
  if (failed(span)) return [{ kind: "failed", start, dur }];
  const queue = Math.min(dur, Number(span.attrs?.queue) || 0);
  const download = Math.min(dur - queue, Number(span.attrs?.download) || 0);
  const wait = dur - queue - download;
  return ([["queue", start, queue], ["wait", start + queue, wait], ["download", start + queue + wait, download]] as const)
    .filter(([, , length]) => length > 0).map(([kind, at, length]) => ({ kind, start: at, dur: length }));
}

/** Requests in start order. An expanded request is followed by its server
 * steps, without the "server total" span that summarises them. */
export function waterfall(trace: StoredTrace, expanded: ReadonlySet<number>) {
  const children = new Map<number, StoredSpan[]>();
  for (const span of trace.spans)
    if (span.parent_seq !== null && span.name !== "server total")
      children.set(span.parent_seq, [...(children.get(span.parent_seq) ?? []), span]);
  const requests = trace.spans.filter((span) => span.kind === "resource" && (isApiRequest(span) || span.duration_ms > 0))
    .sort((a, b) => a.start_ms - b.start_ms || a.seq - b.seq);
  const rows: WaterfallRow[] = [];
  for (const span of requests) {
    const own = (children.get(span.seq) ?? []).sort((a, b) => a.start_ms - b.start_ms);
    rows.push({ span, depth: 0, children: own.length, segments: segments(span), api: isApiRequest(span) });
    if (expanded.has(span.seq))
      for (const child of own) rows.push({ span: child, depth: 1, children: 0, segments: segments(child), api: true });
  }
  const marks = milestones(trace);
  const start = Math.min(0, ...requests.map((span) => span.start_ms));
  const end = Math.max(1, ...requests.map((span) => span.start_ms + span.duration_ms), ...marks.map((mark) => mark.at));
  return { rows, marks, start, end };
}

/** Roughly `count` round tick values from start to end, in milliseconds. */
export function ticks(start: number, end: number, count: number): number[] {
  const raw = (end - start) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 5, 10].map((m) => m * power).find((value) => value >= raw) ?? raw;
  const out: number[] = [];
  for (let value = Math.ceil(start / step) * step; value <= end; value += step) out.push(value);
  return out;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The summary tiles for one page load. */
export function loadStats(trace: StoredTrace) {
  const requests = trace.spans.filter(isApiRequest);
  const ok = requests.filter((span) => !failed(span));
  const at = (name: string) => milestones(trace).find((mark) => mark.name === name)?.at ?? null;
  return {
    feedLoaded: at("feed-loaded"),
    firstPhoto: at("first-visible-photo"),
    requests: requests.length,
    failed: requests.length - ok.length,
    medianServer: median(ok.flatMap((span) => typeof span.attrs?.server_total === "number" ? [span.attrs.server_total] : [])),
  };
}

export const seconds = (ms: number | null) => ms === null ? "—" : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

/** Loads the selected trace so that only the newest request is shown. A
 * slower answer for a page load the member has already moved away from is
 * dropped, along with its error. Selecting clears the old trace while the new
 * one loads; refreshing (after Send now) keeps it until the update arrives. */
export function latestTrace(read: (id: string) => Promise<StoredTrace>, show: (trace: StoredTrace | null) => void) {
  let generation = 0, selected: string | null = null;
  async function load(id: string | null, clear: boolean): Promise<void> {
    const mine = ++generation;
    if (clear) show(null);
    if (!id) return;
    try {
      const trace = await read(id);
      if (mine === generation) show(trace);
    } catch (error) {
      if (mine === generation) throw error;
    }
  }
  return {
    select: (id: string | null) => { selected = id; return load(id, true); },
    refresh: () => load(selected, false),
  };
}
