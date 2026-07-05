-- Track 5: vec0 virtual tables for semantic retrieval.
-- Key columns are PRIMARY KEY so re-digest (INSERT OR REPLACE) and prune (DELETE WHERE id=?)
-- have a target. Requires sqlite-vec extension loaded BEFORE this migration runs.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_vec    USING vec0(turn_id    INTEGER PRIMARY KEY, embedding FLOAT[384]);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec   USING vec0(item_id    INTEGER PRIMARY KEY, embedding FLOAT[384]);
CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec         USING vec0(entity_id  TEXT    PRIMARY KEY, embedding FLOAT[384]);
CREATE VIRTUAL TABLE IF NOT EXISTS session_digest_vec USING vec0(session_id TEXT    PRIMARY KEY, embedding FLOAT[384]);
