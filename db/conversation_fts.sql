-- FTS5 external-content index over conversation.content — SOURCE OF TRUTH.
-- db/migrations/0003_conversation_fts.sql is a copy of this file. To change the FTS setup,
-- edit THIS file first, then copy it into 0003_conversation_fts.sql — never the reverse.
--
-- Append-only index: the conversation table is insert-only (no updates or deletes),
-- so only an AFTER INSERT trigger is needed. content='' means no copy of source data is held.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  content,
  content='',
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS conversation_fts_ai AFTER INSERT ON conversation BEGIN
  INSERT INTO conversation_fts(rowid, content) VALUES (new.rowid, new.content);
END;
