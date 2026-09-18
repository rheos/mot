import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import { loadVecExtension, vecAvailable } from '../lib/vec';

type DB = Database.Database;

let _db: DB | null = null;

export function getDb(): DB {
  if (!_db) {
    const url = process.env.DATABASE_URL ?? './mot.db';
    _db = new Database(url);
    // EC-ARCH-1: WAL + a real busy_timeout make concurrent reader/writer access safe.
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('foreign_keys = ON');
    // Track 5 (FR 1/FR 2): load sqlite-vec at DB-open time, BEFORE migrate_db() runs — the
    // CREATE VIRTUAL TABLE ... USING vec0 in 0007_vec.sql needs the extension already loaded.
    // vecAvailable() flips false (not throw) on a dev/test load failure so the app still boots.
    loadVecExtension(_db);
  }
  return _db;
}

export function getDrizzle() {
  return drizzle(getDb());
}

// Hand-written migrations live in db/migrations but are NOT tracked in drizzle's
// _journal.json (drizzle-kit has no DSL for FTS5 virtual tables / triggers — see
// db/fts.sql). The drizzle migrator only runs journal-tracked files, so we apply the
// extras here in lexicographic order, idempotently, recording them in our own ledger.
const HAND_WRITTEN_MIGRATIONS = [
  '0001_fts.sql',
  '0003_conversation_fts.sql',
  '0004_topic_threads.sql',
  '0005_procedural_notes.sql',
  '0006_memory_fts.sql',
  '0007_vec.sql',
  '0008_relation_draft.sql',
  '0009_surfaced_ledger.sql',
  '0010_embed_version.sql',
];

function applyHandWrittenMigrations(db: DB, migrationsFolder: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS __mot_manual_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const seen = db.prepare('SELECT name FROM __mot_manual_migrations');
  const applied = new Set(
    (seen.all() as { name: string }[]).map((r) => r.name),
  );

  for (const name of HAND_WRITTEN_MIGRATIONS) {
    if (applied.has(name)) continue;
    // Skip the vec migration if the extension didn't load. This is the dev/test degrade
    // path ONLY (EC 1 / FR 18): the box still boots FTS/tickets, just with no semantic
    // tables. In production loadVecExtension re-throws at getDb() and boot fails fast
    // (FR 1, by design), so this guard is never reached there.
    if (name === '0007_vec.sql' && !vecAvailable()) {
      console.warn('[MOT/vec] skipping 0007_vec.sql — sqlite-vec extension not available');
      continue;
    }
    const file = path.join(migrationsFolder, name);
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    const record = db.prepare(
      'INSERT INTO __mot_manual_migrations (name, applied_at) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(name, new Date().toISOString());
    });
    tx();
  }
}

export function migrate_db(): void {
  const migrationsFolder = path.join(process.cwd(), 'db/migrations');
  // Nothing generated yet (e.g. fresh scaffold before `npm run db:generate`): no-op.
  // drizzle's migrate() throws on a missing meta/_journal.json, so gate on it.
  if (!fs.existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
    return;
  }
  // Step 1: drizzle-generated migrations (the base schema, 0000_init.sql).
  migrate(getDrizzle(), { migrationsFolder });
  // Step 2: hand-written migrations drizzle does not track (FTS5).
  applyHandWrittenMigrations(getDb(), migrationsFolder);
}
