-- FTS5 external-content index over conversation.content for keyword search.
-- Keyed to conversation.rowid. Append-only table — no update/delete triggers needed.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  content,
  content='',
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS conversation_fts_ai AFTER INSERT ON conversation BEGIN
  INSERT INTO conversation_fts(rowid, content) VALUES (new.rowid, new.content);
END;
