-- Explicitly consented recordings; separate from legacy performance traces.
CREATE TABLE diagnostic_sessions (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL, device_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('details','content')), consent_version INTEGER NOT NULL,
 started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delete_at INTEGER NOT NULL,
 stopped_at INTEGER, release TEXT
);
CREATE INDEX diagnostic_sessions_member ON diagnostic_sessions(member_id,started_at);
CREATE TABLE diagnostic_events (
 session_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
 kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,id)
) WITHOUT ROWID;
CREATE TABLE diagnostic_access (
 id TEXT PRIMARY KEY, operator TEXT NOT NULL, session_id TEXT NOT NULL,
 action TEXT NOT NULL, at INTEGER NOT NULL
);
