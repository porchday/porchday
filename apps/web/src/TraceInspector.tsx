import React, { useEffect, useMemo, useState } from "react";
import { ApiError, get, localDate, type Json } from "./api";
import { Alert, Button, Loading, useAction } from "./ui";
import { currentTraceId, flushTraces, traceReport, tracingEnabled } from "./tracing";
import { loadStats, seconds, shortLabel, ticks, waterfall, type StoredSpan, type StoredTrace, type WaterfallRow } from "./trace-inspector";

type Summary = {
  routes: { route: string; count: number; failed: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null; server_p50_ms: number | null }[];
  phases: { phase: string; count: number; p50_ms: number; p95_ms: number; max_ms: number }[];
};
type RouteKey = keyof Summary["routes"][number];
const number = new Intl.NumberFormat();
const ms = (value: number | null) => value === null ? "" : number.format(Math.round(value));

/** /app/performance. The signed-in member's own traces, read from the
 * existing /api/v1/traces endpoints; nothing here is visible to anyone else. */
export default function TraceInspector() {
  const [traces, setTraces] = useState<Json[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("trace"));
  const [trace, setTrace] = useState<StoredTrace | null>(null);
  const action = useAction();
  async function load() {
    try {
      const [list, totals] = await Promise.all([get("/traces"), get<Summary>("/traces/summary")]);
      setTraces(list.items || []);
      setSummary(totals);
      setSelected((current) => current && list.items.some((t: Json) => t.trace_id === current) ? current : list.items[0]?.trace_id ?? null);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TRACING_UNAVAILABLE") setUnavailable(true);
      else throw error;
    }
  }
  useEffect(() => { void action.run(load); }, []);
  useEffect(() => {
    if (!selected) return setTrace(null);
    history.replaceState(history.state, "", `/app/performance?trace=${selected}`);
    void action.run(async () => setTrace(await get<StoredTrace>(`/traces/${selected}`)));
  }, [selected]);

  if (unavailable) return <section className="panel"><h1>Performance</h1><Alert>Trace storage is not set up on this server yet.</Alert></section>;
  return (
    <div className="trace-inspector">
      <section className="panel">
        <h1>Performance</h1>
        <p className="small-copy">
          Timings from your own page loads, from this and any other browser where you turned on performance tracing.
          {!tracingEnabled() && <> Tracing is off in this browser; turn it on in <a href="/app/settings/data">Settings → My data</a>.</>}
        </p>
        {traces === null ? <Loading /> : !traces.length ? <p>No traces yet. Load a few pages, then come back.</p> : (
          <div className="trace-picker">
            <label htmlFor="trace-pick">Page load</label>
            <select id="trace-pick" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {traces.map((t) => (
                <option key={t.trace_id} value={t.trace_id}>
                  {localDate(new Date(t.started_at).toISOString())} · {t.page} · {t.browser ?? "?"} · {t.edge ?? "?"} · {t.span_count} spans
                  {t.trace_id === currentTraceId() ? " · this visit" : ""}
                </option>
              ))}
            </select>
            <div className="button-row">
              <Button variant="outline compact" busy={action.busy} disabled={!tracingEnabled()}
                onClick={() => action.run(async () => { await flushTraces(true); await load(); }, "Sent.")}>
                Send now
              </Button>
              {trace && (
                <Button variant="outline compact"
                  onClick={() => action.run(() => navigator.clipboard.writeText(traceReport(trace)), "Copied. Paste it into builder chat.")}>
                  Copy for builder chat
                </Button>
              )}
            </div>
          </div>
        )}
        <Alert>{action.error}</Alert>
        <Alert success>{action.notice}</Alert>
      </section>
      {trace && <LoadTiles trace={trace} />}
      {trace && <Waterfall key={trace.trace_id} trace={trace} />}
      {summary && !!traces?.length && (
        <div className="trace-grid">
          <Phases phases={summary.phases} />
          <Routes routes={summary.routes} />
        </div>
      )}
    </div>
  );
}

function LoadTiles({ trace }: { trace: StoredTrace }) {
  const stats = loadStats(trace);
  const tiles: [string, string, boolean?][] = [
    ["Feed loaded", seconds(stats.feedLoaded)],
    ["First photo shown", seconds(stats.firstPhoto)],
    ["API requests", number.format(stats.requests)],
    ["Failed requests", number.format(stats.failed), stats.failed > 0],
    ["Median server time", seconds(stats.medianServer)],
  ];
  return (
    <section className="trace-tiles" aria-label="This page load">
      {tiles.map(([label, value, bad]) => (
        <div className="trace-tile" key={label}><span>{label}</span><strong className={bad ? "trace-bad" : undefined}>{value}</strong></div>
      ))}
    </section>
  );
}

function describe(span: StoredSpan): string {
  const a = span.attrs ?? {};
  const lines = [span.name, `Starts ${seconds(span.start_ms)}, took ${ms(span.duration_ms)} ms`];
  if (a.queue !== undefined) lines.push(`Queued ${ms(Number(a.queue))} ms, waiting ${ms(Number(a.wait))} ms, downloading ${ms(Number(a.download))} ms`);
  if (a.server_total !== undefined) lines.push(`Server total ${ms(Number(a.server_total))} ms`);
  if (a.body_bytes !== undefined) lines.push(`Size ${number.format(Number(a.body_bytes))} bytes`);
  for (const key of ["status", "edge", "route", "error", "server_error"]) if (a[key] !== undefined) lines.push(`${key.replace("_", " ")}: ${a[key]}`);
  if (a.headers_only) lines.push("Timed to the response headers only");
  return lines.join("\n");
}

function Waterfall({ trace }: { trace: StoredTrace }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const { rows, marks, start, end } = useMemo(() => waterfall(trace, expanded), [trace, expanded]);
  const at = (value: number) => `${((value - start) / (end - start)) * 100}%`;
  const width = (value: number) => `max(2px, ${(value / (end - start)) * 100}%)`;
  const toggle = (row: WaterfallRow) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(row.span.seq)) next.delete(row.span.seq); else next.add(row.span.seq);
    return next;
  });
  return (
    <section className="panel trace-waterfall">
      <h2>Timeline of this page load</h2>
      <p className="small-copy">
        Each row is one request, from when the browser asked to when the last byte arrived. Select a request to show the
        server's own steps inside it. Steps overlap, so they don't add up to the request time. Dashed lines mark milestones.
      </p>
      <ul className="trace-legend">
        <li><i className="trace-queue" />Queued in browser</li>
        <li><i className="trace-wait" />Waiting on server</li>
        <li><i className="trace-download" />Downloading</li>
        <li><i className="trace-step" />Server step</li>
        <li><i className="trace-failed" />Failed</li>
      </ul>
      <div className="trace-rows">
        <div className="trace-row trace-axis" aria-hidden="true">
          <span />
          <div className="trace-track">
            {ticks(start, end, 6).filter((tick) => (tick - start) / (end - start) < 0.94).map((tick) => <span key={tick} style={{ left: at(tick) }}>{seconds(tick)}</span>)}
          </div>
        </div>
        {rows.map((row) => {
          const label = (row.children ? (expanded.has(row.span.seq) ? "▾ " : "▸ ") : "") + shortLabel(row.span.name);
          const bars = (
            <div className="trace-track">
              {row.segments.map((segment, i) => (
                <span key={i} className={`trace-${segment.kind}${row.api ? "" : " trace-asset"}`}
                  style={{ left: at(segment.start), width: width(segment.dur) }} />
              ))}
            </div>
          );
          const className = `trace-row${row.depth ? " trace-child" : ""}`;
          return row.children ? (
            <button type="button" key={row.span.seq} className={className} title={describe(row.span)}
              aria-expanded={expanded.has(row.span.seq)} onClick={() => toggle(row)}>
              <span className="trace-label">{label}</span>{bars}
            </button>
          ) : (
            <div key={row.span.seq} className={className} title={describe(row.span)}>
              <span className="trace-label">{label}</span>{bars}
            </div>
          );
        })}
        <div className="trace-marks" aria-hidden="true">
          {marks.map((mark) => <span key={mark.name} style={{ left: at(mark.at) }} title={`${mark.name} at ${seconds(mark.at)}`} />)}
        </div>
      </div>
      {!!marks.length && (
        <p className="small-copy">Milestones: {marks.map((mark) => `${mark.name} ${seconds(mark.at)}`).join(" · ")}</p>
      )}
    </section>
  );
}

function Phases({ phases }: { phases: Summary["phases"] }) {
  const max = Math.max(1, ...phases.map((phase) => phase.p95_ms));
  return (
    <section className="panel">
      <h2>Where server time goes</h2>
      <p className="small-copy">Each server step across all your page loads: the bar runs to the median, the tick marks the slowest 5%. Successful requests only.</p>
      {!phases.length ? <p className="small-copy">No server steps yet.</p> : (
        <div className="trace-phases">
          {phases.map((phase, i) => (
            <div className="trace-phase" key={phase.phase} title={`${phase.count} times, slowest ${ms(phase.max_ms)} ms`}>
              <span>{phase.phase}</span>
              <div className="trace-phase-track">
                <span className={i ? "trace-phase-bar" : "trace-phase-bar trace-worst"} style={{ width: `${(phase.p50_ms / max) * 100}%` }} />
                <span className="trace-phase-tick" style={{ left: `${(phase.p95_ms / max) * 100}%` }} />
              </div>
              <span className="trace-num">{ms(phase.p50_ms)} / {ms(phase.p95_ms)} ms</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const columns: [RouteKey, string][] = [
  ["route", "Route"], ["count", "Requests"], ["failed", "Failed"], ["p50_ms", "Median ms"],
  ["p95_ms", "p95 ms"], ["max_ms", "Max ms"], ["server_p50_ms", "Server median ms"],
];
function Routes({ routes }: { routes: Summary["routes"] }) {
  const [sort, setSort] = useState<{ key: RouteKey; dir: 1 | -1 }>({ key: "p95_ms", dir: -1 });
  const sorted = routes.slice().sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    return typeof x === "string" ? sort.dir * x.localeCompare(String(y)) : sort.dir * ((x ?? -Infinity) - ((y as number | null) ?? -Infinity));
  });
  return (
    <section className="panel">
      <h2>Slowest requests by route</h2>
      <p className="small-copy">API requests grouped by route across all your page loads. Times are for successful requests; failures are counted separately.</p>
      <div className="trace-table-box">
        <table className="trace-table">
          <thead>
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} aria-sort={sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : key === "route" ? 1 : -1 })}>{label}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.route}>
                <td>{row.route}</td>
                <td>{number.format(row.count)}</td>
                <td className={row.failed ? "trace-bad" : undefined}>{number.format(row.failed)}</td>
                <td>{ms(row.p50_ms)}</td><td>{ms(row.p95_ms)}</td><td>{ms(row.max_ms)}</td><td>{ms(row.server_p50_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
