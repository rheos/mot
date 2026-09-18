-- Instrumentation: what the agents actually ASK for.
--
-- Hand-written (0001+ are hand-written; only 0000_init.sql is generated).
--
-- Motivation: retrieval was tuned four times in one day against assumptions about caller
-- behaviour that nobody could check, because nothing recorded how the MCP tools were invoked.
-- Two separate questions this session ("does Rheo send keywords or sentences?", "which mode does
-- it use?") were unanswerable. This table answers them.
--
-- NOT memory, and deliberately not covered by the persistence invariant: these are operational
-- logs. They may be pruned. `mot.db` and `ontology/graph.jsonl` remain the irreplaceable data.
--
-- Query text is recorded ONLY for read/search tools, where the query itself is the signal being
-- studied. Write tools (ticket bodies, memory content) record a shape summary instead, so this
-- table never becomes a second copy of the content that already lives in its proper store.
CREATE TABLE IF NOT EXISTS tool_call_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,          -- ISO8601 UTC
  tool         TEXT    NOT NULL,
  query        TEXT,                      -- read/search tools only; NULL otherwise
  query_len    INTEGER,                   -- word count, so shape is analysable even when NULL
  mode         TEXT,                      -- fts | vector | hybrid, when the tool takes one
  arg_keys     TEXT,                      -- comma-separated arg names, never their values
  result_count INTEGER,                   -- rows returned, when countable
  duration_ms  INTEGER NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1 -- 0 when the tool threw
);

CREATE INDEX IF NOT EXISTS idx_tool_call_log_ts   ON tool_call_log(ts);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_tool ON tool_call_log(tool, ts);
