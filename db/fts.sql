-- FTS5 external-content virtual table — SOURCE OF TRUTH.
-- db/migrations/0001_fts.sql is a byte-for-byte copy of this file. To change the FTS setup,
-- edit THIS file first, then copy it into 0001_fts.sql — never the reverse.
--
-- content='' means this table holds NO copy of the source data — the base tables
-- (ticket, comment) are canonical. The 6 triggers below keep it in sync inside the SAME
-- transaction as base writes.
CREATE VIRTUAL TABLE IF NOT EXISTS ticket_fts USING fts5(
  title, body, comment_body,
  content='',
  tokenize='porter'
);

-- ===========================================================
-- TICKET triggers
-- ===========================================================

-- After INSERT: index the new row.
CREATE TRIGGER IF NOT EXISTS ticket_fts_ai AFTER INSERT ON ticket BEGIN
  INSERT INTO ticket_fts(rowid, title, body, comment_body)
    VALUES (new.rowid, new.title, new.body, '');
END;

-- After UPDATE of title or body: retract OLD terms first, then index NEW.
-- CRITICAL: the 'delete' command with OLD rowid retracts prior terms from the
-- external-content index. A naive AFTER UPDATE that only inserts new content
-- orphans stale terms — they stay matchable forever. DO NOT simplify this trigger.
CREATE TRIGGER IF NOT EXISTS ticket_fts_au AFTER UPDATE OF title, body ON ticket BEGIN
  INSERT INTO ticket_fts(ticket_fts, rowid, title, body, comment_body)
    VALUES('delete', old.rowid, old.title, old.body, '');
  INSERT INTO ticket_fts(rowid, title, body, comment_body)
    VALUES(new.rowid, new.title, new.body, '');
END;

-- After DELETE: retract terms.
CREATE TRIGGER IF NOT EXISTS ticket_fts_ad AFTER DELETE ON ticket BEGIN
  INSERT INTO ticket_fts(ticket_fts, rowid, title, body, comment_body)
    VALUES('delete', old.rowid, old.title, old.body, '');
END;

-- ===========================================================
-- COMMENT triggers
-- comment_body is keyed to the PARENT ticket's rowid, not the comment's.
-- A comment change re-indexes the parent ticket row (delete-then-insert).
-- ===========================================================

-- After INSERT: re-index parent ticket to add comment_body.
CREATE TRIGGER IF NOT EXISTS comment_fts_ai AFTER INSERT ON comment BEGIN
  INSERT INTO ticket_fts(ticket_fts, rowid, title, body, comment_body)
    SELECT 'delete', t.rowid, t.title, t.body, ''
    FROM ticket t WHERE t.id = new.ticket_id;
  INSERT INTO ticket_fts(rowid, title, body, comment_body)
    SELECT t.rowid, t.title, t.body, new.body
    FROM ticket t WHERE t.id = new.ticket_id;
END;

-- After UPDATE of body: retract old parent index, re-index with new comment_body.
CREATE TRIGGER IF NOT EXISTS comment_fts_au AFTER UPDATE OF body ON comment BEGIN
  INSERT INTO ticket_fts(ticket_fts, rowid, title, body, comment_body)
    SELECT 'delete', t.rowid, t.title, t.body, ''
    FROM ticket t WHERE t.id = new.ticket_id;
  INSERT INTO ticket_fts(rowid, title, body, comment_body)
    SELECT t.rowid, t.title, t.body, new.body
    FROM ticket t WHERE t.id = new.ticket_id;
END;

-- After DELETE: retract old parent index.
CREATE TRIGGER IF NOT EXISTS comment_fts_ad AFTER DELETE ON comment BEGIN
  INSERT INTO ticket_fts(ticket_fts, rowid, title, body, comment_body)
    SELECT 'delete', t.rowid, t.title, t.body, ''
    FROM ticket t WHERE t.id = old.ticket_id;
  INSERT INTO ticket_fts(rowid, title, body, comment_body)
    SELECT t.rowid, t.title, t.body, ''
    FROM ticket t WHERE t.id = old.ticket_id;
END;
