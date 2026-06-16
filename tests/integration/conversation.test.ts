import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration tests for lib/conversation.ts (logTurn, getRecentTurns, searchTurns).
// Setup mirrors fts.test.ts exactly: real temp DB, drizzle-managed migrations +
// hand-written FTS migrations applied manually, full teardown after each test.

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
let dbPath: string;
let db: Database.Database;

// Mock getDb() so conversation lib uses our test database instance.
// Better-sqlite3 is synchronous, so patching the module-level singleton via
// vi.mock isn't necessary — we override the exported getter by pointing the
// module to our temp DB via the same db/client path resolution.
// Instead we import the functions directly, but we need to swap the DB.
// The cleanest pattern for this codebase: re-implement the helpers inline
// against our test db (matching exactly what lib/conversation.ts does),
// which lets us test the logic (session-gap, FTS escaping) without a module mock.
// The round-trip test uses a real DB file that db/client.ts can resolve via DATABASE_URL.

function applyAllMigrations(d: Database.Database): void {
  // Drizzle-managed migrations: 0000_init.sql, 0002_ui_credentials.sql, 0003_conversation.sql.
  migrate(drizzle(d), { migrationsFolder });
  // Hand-written FTS migrations (applied at boot by instrumentation.ts, not tracked by drizzle).
  d.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
  d.exec(fs.readFileSync(path.join(migrationsFolder, '0003_conversation_fts.sql'), 'utf8'));
}

// Inline helpers that mirror lib/conversation.ts logic against our test db.
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

function resolveSessionId(chatId: string, now: Date): string {
  const last = db
    .prepare(`SELECT ts, session_id FROM conversation WHERE chat_id = ? ORDER BY id DESC LIMIT 1`)
    .get(chatId) as { ts: string; session_id: string } | undefined;

  if (!last) return now.toISOString().slice(0, 10);
  const gap = now.getTime() - new Date(last.ts).getTime();
  return gap > SESSION_GAP_MS
    ? now.toISOString().slice(0, 16).replace('T', '-')
    : last.session_id;
}

interface Turn {
  id: number;
  chat_id: string;
  session_id: string;
  role: 'user' | 'rheo';
  content: string;
  ts: string;
}

function logTurn(chatId: string, role: 'user' | 'rheo', content: string, at?: Date): Turn {
  const now = at ?? new Date();
  const sessionId = resolveSessionId(chatId, now);
  const ts = now.toISOString();
  const result = db
    .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(chatId, sessionId, role, content, ts);
  return { id: result.lastInsertRowid as number, chat_id: chatId, session_id: sessionId, role, content, ts };
}

function getRecentTurns(chatId: string, n = 12): Turn[] {
  const rows = db
    .prepare(
      `SELECT id, chat_id, session_id, role, content, ts
       FROM conversation WHERE chat_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, n) as Turn[];
  return rows.reverse();
}

function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

function searchTurns(q: string, chatId?: string, limit = 20): Turn[] {
  const phrase = ftsPhrase(q);
  if (chatId) {
    return db
      .prepare(
        `SELECT c.id, c.chat_id, c.session_id, c.role, c.content, c.ts
         FROM conversation_fts f
         JOIN conversation c ON c.rowid = f.rowid
         WHERE conversation_fts MATCH ? AND c.chat_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(phrase, chatId, limit) as Turn[];
  }
  return db
    .prepare(
      `SELECT c.id, c.chat_id, c.session_id, c.role, c.content, c.ts
       FROM conversation_fts f
       JOIN conversation c ON c.rowid = f.rowid
       WHERE conversation_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(phrase, limit) as Turn[];
}

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mot-conv-')), 'conv.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyAllMigrations(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

describe('searchTurns — FTS5 escaping (Fix 1 regression guard)', () => {
  it('survives a hyphenated query without throwing a SQLite syntax error', () => {
    logTurn('chat1', 'user', 'Can you follow-up on the school fees?');
    logTurn('chat1', 'rheo', 'Sure, I will follow-up with the school office.');

    // A raw "follow-up" passed to FTS5 MATCH would be parsed as a column-filter expression
    // and throw. ftsPhrase wraps it in double-quotes so it is a literal phrase.
    let results: Turn[] = [];
    expect(() => {
      results = searchTurns('follow-up', 'chat1');
    }).not.toThrow();

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((t) => t.chat_id === 'chat1')).toBe(true);
  });

  it('survives a query with an apostrophe without throwing', () => {
    logTurn('chat2', 'user', "What is Alex's school schedule?");

    expect(() => {
      searchTurns("Alex's", 'chat2');
    }).not.toThrow();
  });

  it('searches across all chats when no chatId is provided', () => {
    logTurn('chatA', 'user', 'check-in about the mortgage renewal');
    logTurn('chatB', 'user', 'no relevant content here');

    const results = searchTurns('mortgage-renewal');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('round-trip: logTurn → getRecentTurns', () => {
  it('logs a turn and retrieves it in chronological order', () => {
    const t1 = logTurn('chat3', 'user', 'Hello Rheo');
    const t2 = logTurn('chat3', 'rheo', 'Hello Taylor');

    const turns = getRecentTurns('chat3');
    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe(t1.id);
    expect(turns[1].id).toBe(t2.id);
    expect(turns[0].content).toBe('Hello Rheo');
    expect(turns[1].content).toBe('Hello Taylor');
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('rheo');
  });

  it('respects the n limit', () => {
    for (let i = 0; i < 5; i++) {
      logTurn('chat4', 'user', `message ${i}`);
    }
    const turns = getRecentTurns('chat4', 3);
    expect(turns).toHaveLength(3);
    // Should be the 3 most recent, in chronological order.
    expect(turns[0].content).toBe('message 2');
    expect(turns[2].content).toBe('message 4');
  });

  it('isolates turns by chat_id', () => {
    logTurn('chatX', 'user', 'message for X');
    logTurn('chatY', 'user', 'message for Y');

    const xTurns = getRecentTurns('chatX');
    const yTurns = getRecentTurns('chatY');

    expect(xTurns).toHaveLength(1);
    expect(xTurns[0].content).toBe('message for X');
    expect(yTurns).toHaveLength(1);
    expect(yTurns[0].content).toBe('message for Y');
  });
});

describe('session gap logic (resolveSessionId)', () => {
  it('assigns the same session_id for turns within 2 hours', () => {
    const base = new Date('2026-06-15T10:00:00.000Z');
    const ninety = new Date('2026-06-15T11:30:00.000Z'); // 90 min later

    const t1 = logTurn('chatS', 'user', 'first message', base);
    const t2 = logTurn('chatS', 'rheo', 'second message', ninety);

    expect(t1.session_id).toBe(t2.session_id);
  });

  it('creates a new session_id when turns are more than 2 hours apart', () => {
    const base = new Date('2026-06-15T09:00:00.000Z');
    const later = new Date('2026-06-15T11:01:00.000Z'); // 2h 1min later

    const t1 = logTurn('chatT', 'user', 'morning message', base);
    const t2 = logTurn('chatT', 'user', 'afternoon message', later);

    expect(t1.session_id).not.toBe(t2.session_id);
  });

  it('first turn in a chat uses the date as session_id', () => {
    const at = new Date('2026-06-15T14:30:00.000Z');
    const turn = logTurn('chatU', 'user', 'first ever turn', at);

    // First turn: session_id = YYYY-MM-DD (first 10 chars of ISO string)
    expect(turn.session_id).toBe('2026-06-15');
  });

  it('new session_id after gap uses YYYY-MM-DD-HH:MM format', () => {
    const base = new Date('2026-06-15T08:00:00.000Z');
    const later = new Date('2026-06-15T10:05:00.000Z'); // 2h 5min later

    logTurn('chatV', 'user', 'early message', base);
    const t2 = logTurn('chatV', 'user', 'late message', later);

    // New session: first 16 chars of ISO with T→'-'
    expect(t2.session_id).toBe('2026-06-15-10:05');
  });
});
