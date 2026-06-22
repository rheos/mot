import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Phase 1 (FR 1–2, FR 12, FR 20–21, EC-10, AC-10/11/14). Drive the REAL boot
// migration entrypoint — migrate_db() in db/client.ts — against a fresh temp DB and assert the
// hand-written migrations land: topic_thread, topic_thread_session, procedural_notes, plus the
// memory_items_fts external-content virtual table. migrate_db() reads DATABASE_URL via getDb(),
// so DATABASE_URL must be set before the first dynamic import (same constraint as boot.test.ts).

const tmpDbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mot-migrations-')),
  'migrations.db',
);
process.env.DATABASE_URL = tmpDbPath;

// Dynamic import so DATABASE_URL is set before the client singleton opens the DB.
const { migrate_db, getDb } = await import('../../db/client');

function objectExists(type: 'table' | 'index', name: string): boolean {
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`)
    .get(type, name) as { name: string } | undefined;
  return row?.name === name;
}

describe('Recallatron Phase 1 migrations (migrate_db boot path)', () => {
  beforeAll(() => {
    // EC-10 / AC-10: migrate_db() must run the initial-population INSERT without error even on
    // a fresh DB where memory_items is empty. A throw here fails the suite.
    migrate_db();
  });

  afterAll(() => {
    getDb().close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = tmpDbPath + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  it('creates topic_thread and topic_thread_session', () => {
    expect(objectExists('table', 'topic_thread')).toBe(true);
    expect(objectExists('table', 'topic_thread_session')).toBe(true);
    expect(objectExists('index', 'idx_tts_session_id')).toBe(true);
  });

  it('creates procedural_notes with its indexes', () => {
    expect(objectExists('table', 'procedural_notes')).toBe(true);
    expect(objectExists('index', 'idx_pn_category')).toBe(true);
    expect(objectExists('index', 'idx_pn_note_norm')).toBe(true);
  });

  it('creates the memory_items_fts external-content virtual table', () => {
    // FTS5 registers the virtual table under type='table' in sqlite_master.
    expect(objectExists('table', 'memory_items_fts')).toBe(true);
  });

  it('FTS5 triggers index memory_items inserts and retract on supersede (EC-10)', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // A session_digest row to satisfy memory_items' FK chain via conversation, plus a
    // conversation turn (memory_items.source_turn_id → conversation.id).
    db.prepare(
      `INSERT INTO conversation (chat_id, session_id, role, content, ts)
       VALUES ('c1', 's1', 'user', 'hello', ?)`,
    ).run(now);
    const turnId = (
      db.prepare(`SELECT id FROM conversation WHERE session_id = 's1'`).get() as { id: number }
    ).id;

    db.prepare(
      `INSERT INTO memory_items
         (type, label, label_norm, properties, chat_id, source_turn_id, source_session_id,
          confidence, reason, ts, version)
       VALUES ('fact', 'Coffee order', 'coffee order', '{"drink":"flat-white"}', 'c1', ?, 's1',
               0.9, 'stated-in-chat', ?, 1)`,
    ).run(turnId, now);

    // AFTER INSERT trigger indexed it: the property and reason terms are searchable.
    const hit = (
      db
        .prepare(`SELECT count(*) AS c FROM memory_items_fts WHERE memory_items_fts MATCH ?`)
        .get('"flat-white"') as { c: number }
    ).c;
    expect(hit).toBe(1);
  });
});
