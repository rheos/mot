-- Procedural notes (Recallatron Phase 1) — hand-written, NOT tracked in drizzle's _journal.json.
-- Applied via applyHandWrittenMigrations() in db/client.ts. Append-only with a supersede chain
-- (superseded_by self-FK), mirroring memory_items. note_norm is the normalized form used for
-- dedup/lookup. source_session_id FK references session_digest(session_id) — the UNIQUE column,
-- NOT the autoincrement PK.
CREATE TABLE IF NOT EXISTS procedural_notes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category          TEXT NOT NULL,
  note              TEXT NOT NULL,
  note_norm         TEXT NOT NULL,
  source_session_id TEXT NOT NULL REFERENCES session_digest(session_id),
  confirmed         INTEGER NOT NULL DEFAULT 0,
  confirmed_at      TEXT,
  superseded_by     INTEGER REFERENCES procedural_notes(id),
  mention_count     INTEGER NOT NULL DEFAULT 1,
  chat_id           TEXT,
  created_at        TEXT NOT NULL,
  ts                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pn_category ON procedural_notes(category, confirmed, superseded_by);
CREATE INDEX IF NOT EXISTS idx_pn_note_norm ON procedural_notes(note_norm);
