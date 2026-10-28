import React, { useEffect, useState } from "react";
import { ApiError, del, get, localDate, type Json } from "./api";
import { Alert, Button, useAction } from "./ui";
import { currentTraceId, flushTraces, setTracingEnabled, traceReport, tracingEnabled } from "./tracing";

/** Settings → My data. Opt-in performance traces for this browser. */
export function PerformanceTracing() {
  const [enabled, setEnabled] = useState(tracingEnabled());
  const [traces, setTraces] = useState<Json[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [report, setReport] = useState<{ id: string; text: string } | null>(null);
  const action = useAction();
  async function load() {
    try {
      setTraces((await get("/traces")).items || []);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TRACING_UNAVAILABLE") setUnavailable(true);
      else throw error;
    }
  }
  useEffect(() => {
    if (enabled) void action.run(load);
  }, [enabled]);
  async function open(id: string) {
    const trace = await get<Parameters<typeof traceReport>[0]>(`/traces/${id}`);
    setReport({ id, text: traceReport(trace) });
  }
  return (
    <section className="panel form-stack">
      <h2>Performance tracing</h2>
      <p>
        When this is on, this browser records how long each page load,
        request, photo and decryption step takes, and sends those timings to
        Porchday so the builders can see where time goes. Traces include the
        addresses of what you opened (such as post and photo IDs), timings,
        browser version and short error codes. They never include post text,
        photos, keys or anything decrypted. Nothing goes to any other company.
        Traces are deleted after 14 days, or when you delete them here or
        delete your account.
      </p>
      <label className="check-field">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setTracingEnabled(e.target.checked);
            setEnabled(e.target.checked);
            if (!e.target.checked) setReport(null);
          }}
        />
        <span>Share performance traces from this browser</span>
      </label>
      {unavailable && <Alert>Trace storage is not set up on this server yet.</Alert>}
      {enabled && !unavailable && (
        <>
          <p className="small-copy">
            This visit: <code>{currentTraceId() ?? "starting…"}</code>. Traces
            upload once a minute and when you leave the page.
          </p>
          <div className="button-row">
            <Button variant="outline compact" busy={action.busy}
              onClick={() => action.run(async () => { await flushTraces(true); await load(); }, "Sent.")}>
              Send now
            </Button>
            <Button variant="quiet compact" busy={action.busy}
              onClick={() => action.run(async () => { await del("/traces"); setTraces([]); setReport(null); }, "Your traces were deleted.")}>
              Delete my traces
            </Button>
          </div>
          {traces && !traces.length && <p className="small-copy">No traces yet.</p>}
          {traces?.map((t) => (
            <div className="member-row" key={t.trace_id}>
              <span>
                {localDate(new Date(t.started_at).toISOString())} · {t.page} · {t.span_count} spans
                {t.trace_id === currentTraceId() ? " · this visit" : ""}
              </span>
              <Button variant="outline compact" busy={action.busy} onClick={() => action.run(() => open(t.trace_id))}>
                View
              </Button>
            </div>
          ))}
          {report && (
            <>
              <pre className="trace-report" aria-label="Trace waterfall">{report.text}</pre>
              <Button variant="outline compact"
                onClick={() => action.run(() => navigator.clipboard.writeText(report.text), "Copied. Paste it into builder chat.")}>
                Copy for builder chat
              </Button>
            </>
          )}
        </>
      )}
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
    </section>
  );
}
