-- Topic threads (Recallatron Phase 1) — hand-written, NOT tracked in drizzle's _journal.json.
-- Applied via applyHandWrittenMigrations() in db/client.ts. topic_thread groups sessions under
-- a human-readable topic; topic_thread_session is the many-to-many join to session_digest.
-- FK references session_digest(session_id) — the UNIQUE column, NOT the autoincrement PK.
CREATE TABLE IF NOT EXISTS topic_thread (
  slug           TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_thread_session (
  slug       TEXT NOT NULL REFERENCES topic_thread(slug),
  session_id TEXT NOT NULL REFERENCES session_digest(session_id),
  added_at   TEXT NOT NULL,
  PRIMARY KEY (slug, session_id)
);

CREATE INDEX IF NOT EXISTS idx_tts_session_id ON topic_thread_session(session_id);
