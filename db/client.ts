import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';

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
const HAND_WRITTEN_MIGRATIONS = ['0001_fts.sql'];

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
