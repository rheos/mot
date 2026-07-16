CREATE TABLE IF NOT EXISTS surfaced_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id    TEXT    NOT NULL,
  horizon_days INTEGER NOT NULL,
  surfaced_at  TEXT    NOT NULL,
  UNIQUE (entity_id, horizon_days)
);
