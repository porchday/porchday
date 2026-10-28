-- Opt-in performance traces (docs/performance-tracing.md). Separate from
-- Postgres so tracing never competes for application database connections.
-- Retention: the daily cron deletes traces 14 days after their last upload.
CREATE TABLE traces (
  trace_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,   -- browser time origin, epoch milliseconds
  received_at INTEGER NOT NULL,  -- latest upload, epoch milliseconds
  page TEXT NOT NULL,
  browser TEXT,
  connection TEXT,
  edge TEXT,
  release TEXT,
  span_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX traces_member_started ON traces(member_id, started_at DESC);
CREATE INDEX traces_received ON traces(received_at);

CREATE TABLE trace_spans (
  trace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  start_ms REAL NOT NULL,        -- relative to the trace's time origin
  duration_ms REAL NOT NULL,
  attrs TEXT,                    -- JSON object of bounded scalar fields
  PRIMARY KEY (trace_id, seq)
) WITHOUT ROWID;
