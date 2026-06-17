import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration tests for lib/conversation.ts (logTurn, getRecentTurns, searchTurns).
// These tests call the REAL exported functions so that any drift in lib/conversation.ts
// will be caught here. Setup mirrors fts.test.ts: real temp DB, drizzle migrator +
// hand-written FTS migrations applied in lexicographic order, WAL + foreign keys.
//
// DATABASE_URL is set at module top level, before any dynamic import of db/client or
// lib/conversation, so getDb() singleton opens our temp DB (not ./mot.db).

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-conv-'));
const dbPath = path.join(tmpDir, 'conv.db');

// Set env var BEFORE any module import that calls getDb().
process.env.DATABASE_URL = dbPath;

// Seed DB and apply all migrations (base + both hand-written FTS files).
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
migrate(drizzle(seed), { migrationsFolder });
seed.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
seed.exec(fs.readFileSync(path.join(migrationsFolder, '0003_conversation_fts.sql'), 'utf8'));
seed.close();

// Dynamic imports so DATABASE_URL is set before the singleton initialises.
const { logTurn, getRecentTurns, searchTurns } = await import('../../lib/conversation');

// A second connection for direct DB seeding (session-gap tests need to plant a row
// with an explicit past timestamp without going through logTurn, which always uses now).
// This connection shares the same WAL file — writes are visible to getDb() immediately.
const directDb = new Database(dbPath);

afterAll(() => {
  directDb.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

// ── helper: plant a row with an explicit timestamp directly ───────────────────
function seedTurn(
  chatId: string,
  sessionId: string,
  role: 'user' | 'rheo',
  content: string,
  ts: string,
): void {
  directDb
    .prepare(
      `INSERT INTO conversation (chat_id, session_id, role, content, ts)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(chatId, sessionId, role, content, ts);
}

// ── FTS5 escaping ─────────────────────────────────────────────────────────────
describe('searchTurns — FTS5 escaping (Fix 1 regression guard)', () => {
  it('survives a hyphenated query without throwing a SQLite syntax error', () => {
    logTurn('chat1', 'user', 'Can you follow-up on the school fees?');
    logTurn('chat1', 'rheo', 'Sure, I will follow-up with the school office.');

    // A raw "follow-up" passed to FTS5 MATCH would be parsed as a column-filter expression
    // and throw. ftsPhrase wraps it in double-quotes so it is a literal phrase.
    let results: Awaited<ReturnType<typeof getRecentTurns>> = [];
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

// ── round-trip: logTurn → getRecentTurns ─────────────────────────────────────
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
    // getRecentTurns returns DESC-then-reversed, so most-recent n in chronological order.
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

// ── session-gap boundary ──────────────────────────────────────────────────────
// resolveSessionId is NOT exported — we drive the session-gap behaviour through
// logTurn by seeding a prior row with an explicit past timestamp directly into the DB
// (bypassing logTurn, which always uses now). We then call the real logTurn and
// read back the session_id via getRecentTurns (or a direct DB query) to assert.
describe('session gap logic (via logTurn + direct DB seed)', () => {
  it('assigns the same session_id for turns within 2 hours', () => {
    // Seed a turn 90 minutes in the past.
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    seedTurn('chatS', '2026-06-15', 'user', 'seeded 90 min ago', ninetyMinAgo);

    // logTurn fires with now — should be within the 2h window, same session.
    const t2 = logTurn('chatS', 'rheo', 'reply within same session');

    const turns = getRecentTurns('chatS');
    const seededTurn = turns.find((t) => t.content === 'seeded 90 min ago');
    expect(seededTurn).toBeDefined();
    expect(t2.session_id).toBe(seededTurn!.session_id);
  });

  it('creates a new session_id when turns are more than 2 hours apart', () => {
    // Seed a turn 2h 5min in the past.
    const twoHoursFiveMinAgo = new Date(Date.now() - (2 * 60 + 5) * 60 * 1000).toISOString();
    const oldSessionId = '2026-06-15';
    seedTurn('chatT', oldSessionId, 'user', 'seeded 2h5m ago', twoHoursFiveMinAgo);

    // logTurn fires with now — gap > 2h, should open a new session.
    const t2 = logTurn('chatT', 'user', 'much later message');

    expect(t2.session_id).not.toBe(oldSessionId);
  });

  it('first turn in a chat uses the date as session_id', () => {
    // No seed — chatU is fresh. logTurn should set session_id = YYYY-MM-DD.
    const t = logTurn('chatU', 'user', 'first ever turn');

    // session_id for the first turn is the ISO date (first 10 chars).
    const today = new Date().toISOString().slice(0, 10);
    expect(t.session_id).toBe(today);
  });

  it('new session_id after gap uses YYYY-MM-DD-HH:MM format', () => {
    // Seed a turn 2h 5min in the past.
    const pastTs = new Date(Date.now() - (2 * 60 + 5) * 60 * 1000).toISOString();
    seedTurn('chatV', '2026-06-15', 'user', 'early message', pastTs);

    const t2 = logTurn('chatV', 'user', 'late message');

    // New session: "YYYY-MM-DD-HH:MM" (ISO first 16 chars with T replaced by '-').
    expect(t2.session_id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/);
    // The session_id should match approximately now.
    const expectedPrefix = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const expectedFormatted = expectedPrefix.replace('T', '-');    // "YYYY-MM-DD-HH"
    expect(t2.session_id.startsWith(expectedFormatted)).toBe(true);
  });
});
