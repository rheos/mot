-- Track 5 follow-up — record which embed-input representation produced each stored vector.
--
-- Hand-written (0001+ are hand-written; only 0000_init.sql is generated).
--
-- A sidecar rather than a column on the vec0 tables: adding a column to a vec0 virtual table
-- means recutting all four of them and re-embedding everything to change one integer. The
-- sidecar also stays readable when the sqlite-vec extension fails to load, which is exactly
-- when you most want to know what state the index is in.
--
-- NO DATA MIGRATION. Rows written before this migration simply have no entry here, and every
-- reader treats a missing entry as IMPLICIT_EMBED_VERSION (1). Backfilling ~1k rows at migration
-- time would be pure write churn for information that absence already conveys.
CREATE TABLE IF NOT EXISTS vec_meta (
  table_name    TEXT    NOT NULL,
  row_id        TEXT    NOT NULL,
  embed_version INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
);

-- Serves both the coverage query and the backfill's stale-row selection.
CREATE INDEX IF NOT EXISTS idx_vec_meta_version ON vec_meta(table_name, embed_version);
