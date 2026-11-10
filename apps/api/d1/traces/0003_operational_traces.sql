-- First-party operational metadata only; separate from consented member content.
CREATE TABLE operational_traces (
 trace_id TEXT NOT NULL,root_id TEXT NOT NULL,started_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL,
 route TEXT NOT NULL,status INTEGER NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(trace_id,root_id)
) WITHOUT ROWID;
CREATE INDEX operational_traces_root ON operational_traces(root_id);
CREATE INDEX operational_traces_started ON operational_traces(started_at);
CREATE INDEX operational_traces_expiry ON operational_traces(expires_at);
CREATE INDEX operational_traces_status ON operational_traces(status,started_at);
CREATE TABLE operational_trace_links (
 linked_trace TEXT NOT NULL,trace_id TEXT NOT NULL,root_id TEXT NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(linked_trace,trace_id,root_id)
) WITHOUT ROWID;
CREATE INDEX operational_trace_links_expiry ON operational_trace_links(expires_at);
-- Correlate consented client measurements without scanning recording contents.
CREATE INDEX diagnostic_events_trace ON diagnostic_events(json_extract(payload,'$.trace'));
CREATE INDEX trace_spans_causal_trace ON trace_spans(json_extract(attrs,'$.trace_id'));
