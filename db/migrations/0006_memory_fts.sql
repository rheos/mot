-- FTS5 external-content index over memory_items (label, properties, reason) — SOURCE OF TRUTH.
-- db/migrations/0006_memory_fts.sql is a byte-for-byte copy of this file. To change the FTS
-- setup, edit THIS file first, then copy it into 0006_memory_fts.sql — never the reverse.
--
-- content='' means this table holds NO copy of the source data — memory_items is canonical.
-- The triggers below keep it in sync inside the SAME transaction as base writes.
-- memory_items is append-only EXCEPT for the single superseded_by UPDATE (lib/memory.ts:194),
-- so only AFTER INSERT and AFTER UPDATE OF superseded_by triggers exist — no DELETE trigger.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  label, properties, reason,
  content='',
  tokenize='porter'
);

-- After INSERT: index the new row.
CREATE TRIGGER IF NOT EXISTS memory_items_fts_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_items_fts(rowid, label, properties, reason)
    VALUES (new.rowid, new.label, new.properties, new.reason);
END;

-- After UPDATE of superseded_by: retract OLD terms first, then index NEW.
-- CRITICAL: the 'delete' command with OLD rowid retracts prior terms from the
-- external-content index. A naive AFTER UPDATE that only inserts new content
-- orphans stale terms — they stay matchable forever. DO NOT simplify this trigger.
-- (superseded_by is the only mutation memory_items ever takes — lib/memory.ts:194 — so
-- label/properties/reason are unchanged across the update, but the retract-then-insert
-- pattern is kept verbatim so the index never drifts if that ever changes.)
CREATE TRIGGER IF NOT EXISTS memory_items_fts_au AFTER UPDATE OF superseded_by ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, label, properties, reason)
    VALUES('delete', old.rowid, old.label, old.properties, old.reason);
  INSERT INTO memory_items_fts(rowid, label, properties, reason)
    VALUES(new.rowid, new.label, new.properties, new.reason);
END;

-- Initial population (EC-10, AC-10): index any rows that already exist when this migration
-- runs, so the index is consistent with memory_items written before the FTS table existed.
INSERT INTO memory_items_fts(rowid, label, properties, reason)
  SELECT id, label, properties, reason FROM memory_items;
