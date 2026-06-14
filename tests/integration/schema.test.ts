import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Apply the GENERATED base migration (0000_init.sql) to a fresh temp DB and assert the
// FR-DB-1 contract: 4 tables, 3 named indexes, 19 ticket columns. ticket_fts must NOT
// exist yet — it arrives in Prompt 3 (0001_fts.sql).

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mot-schema-')), 'schema.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(drizzle(db), { migrationsFolder });
});

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe('schema migration (FR-DB-1)', () => {
  it('creates the 4 contract tables', () => {
    const tables = tableNames();
    for (const t of ['ticket', 'comment', 'classification_audit', 'app_secret']) {
      expect(tables).toContain(t);
    }
  });

  it('does NOT create ticket_fts yet (arrives in Prompt 3)', () => {
    expect(tableNames()).not.toContain('ticket_fts');
  });

  it('creates the 3 named indexes', () => {
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const idx of [
      'idx_ticket_dedup_key',
      'idx_ticket_triage',
      'idx_ticket_snooze',
    ]) {
      expect(indexes).toContain(idx);
    }
  });

  it('ticket has exactly the 19 FR-DB-1 columns', () => {
    const cols = (
      db.prepare('PRAGMA table_info(ticket)').all() as { name: string }[]
    ).map((c) => c.name);
    const expected = [
      'id',
      'title',
      'ministry',
      'status',
      'severity',
      'ticket_type',
      'provenance',
      'source_ref',
      'dedup_key',
      'body',
      'private',
      'needs_review',
      'event_count',
      'snoozed_until',
      'blocked_note',
      'linked_ticket_id',
      'created_at',
      'updated_at',
      'closed_at',
    ];
    expect(cols.sort()).toEqual(expected.sort());
    expect(cols).toHaveLength(19);
  });

  it('status defaults to open', () => {
    const info = db.prepare('PRAGMA table_info(ticket)').all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const status = info.find((c) => c.name === 'status');
    expect(status?.dflt_value).toBe("'open'");
  });
});
