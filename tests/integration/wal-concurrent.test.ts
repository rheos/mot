import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// EC-ARCH-1 — WAL + busy_timeout under REAL concurrency.
//
// boot.test.ts asserts the pragmas are SET on the singleton; this asserts they WORK across
// independent connections. WAL lets a writer hold an OPEN write transaction while a separate
// reader reads the last committed snapshot without blocking or erroring (the headline race), and
// it serializes overlapping writes from two connections so none is lost. busy_timeout=5000 is the
// cross-process writer backstop (the Next.js app vs. a separate cron/tool process); better-sqlite3
// is synchronous and single-threaded, so two writers can't truly overlap in-process — we assert
// the pragma is live on each connection and that interleaved writes all land consistently.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-wal-concurrent-'));
const dbPath = path.join(dir, 'wal-concurrent.db');

const migrationsFolder = path.join(process.cwd(), 'db/migrations');

// Open a fresh connection with the same pragmas the app's db/client.ts sets at boot.
function openConn(): Database.Database {
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  return conn;
}

const INSERT_TICKET = `INSERT INTO ticket
  (id, title, ministry, status, severity, ticket_type, provenance, body,
   private, needs_review, event_count, created_at, updated_at)
  VALUES (?, ?, 'works', 'open', 'high', 'infra-alert', 'sentry-alert', 'body',
   0, 0, 1, datetime('now'), datetime('now'))`;

// Apply both migrations once (drizzle base 0000 + hand-written FTS 0001) on a setup connection.
{
  const seed = openConn();
  migrate(drizzle(seed), { migrationsFolder });
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
  seed.close();
}

describe('EC-ARCH-1 — WAL + busy_timeout concurrency', () => {
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('opens in WAL mode on every connection', () => {
    const conn = openConn();
    const mode = conn.pragma('journal_mode') as { journal_mode: string }[];
    expect(mode[0].journal_mode).toBe('wal');
    conn.close();
  });

  it('lets a reader read while a write transaction is open on another connection', async () => {
    const writer = openConn();
    const reader = openConn();
    try {
      // Seed a baseline row outside any transaction so the reader has something to read.
      writer.prepare(INSERT_TICKET).run('base', 'Base');

      // Open an EXPLICIT write transaction and hold it open across a concurrent read. In a
      // rollback journal this read could block on the writer's lock; in WAL it must not.
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare(INSERT_TICKET).run('in-tx', 'In transaction');

      // Reader runs while writer's transaction is still open and UNCOMMITTED. WAL readers see
      // the last committed snapshot: 'base' is visible, the uncommitted 'in-tx' is not — and,
      // critically, the read does NOT error or hang.
      const base = reader.prepare('SELECT id FROM ticket WHERE id = ?').get('base') as
        | { id: string }
        | undefined;
      const uncommitted = reader.prepare('SELECT id FROM ticket WHERE id = ?').get('in-tx') as
        | { id: string }
        | undefined;
      expect(base?.id).toBe('base');
      expect(uncommitted).toBeUndefined();

      writer.exec('COMMIT');

      // After commit, a fresh read on the reader connection now sees the committed row.
      const nowVisible = reader.prepare('SELECT id FROM ticket WHERE id = ?').get('in-tx') as
        | { id: string }
        | undefined;
      expect(nowVisible?.id).toBe('in-tx');
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('busy_timeout is effective on every connection (the writer-contention backstop)', () => {
    // busy_timeout is what makes a SECOND writer wait-and-retry instead of throwing
    // SQLITE_BUSY the instant it finds the write lock held. In this single-threaded,
    // synchronous better-sqlite3 process two writers can't truly overlap in-process — but the
    // pragma is the cross-process backstop (the Next.js app vs. a separate cron/tool process),
    // and it must be live on each connection the app or a tool opens. Assert it is.
    const a = openConn();
    const b = openConn();
    try {
      const ta = (a.pragma('busy_timeout') as { timeout: number }[])[0].timeout;
      const tb = (b.pragma('busy_timeout') as { timeout: number }[])[0].timeout;
      expect(ta).toBe(5000);
      expect(tb).toBe(5000);
    } finally {
      a.close();
      b.close();
    }
  });

  it('interleaves writes from two connections and the final state is consistent', () => {
    // Two independent connections fire overlapping writes (each an implicit transaction, the
    // app's actual write shape — getDb() + a single .run()). WAL serializes them at commit; no
    // write is lost or corrupted. We round-robin 20 inserts across A and B and assert all 20
    // landed exactly once.
    const a = openConn();
    const b = openConn();
    try {
      const N = 20;
      for (let i = 0; i < N; i++) {
        const conn = i % 2 === 0 ? a : b;
        conn.prepare(INSERT_TICKET).run(`race-${i}`, `Race ${i}`);
      }
      // Read the final state from a THIRD connection to prove durability across connections.
      const reader = openConn();
      const count = (
        reader.prepare("SELECT COUNT(*) AS n FROM ticket WHERE id LIKE 'race-%'").get() as {
          n: number;
        }
      ).n;
      reader.close();
      expect(count).toBe(N);
    } finally {
      a.close();
      b.close();
    }
  });
});
