import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Track 7 Prompt 1 — AC-16 (surfaced_ledger table + UNIQUE constraint) and AC-17
// (sendTelegramNotify + the notify_robin MCP envelope, extracted verbatim into lib/notify.ts).
//
// MOT_EMBED_DISABLE=1 so no vec extension is needed. The whole Vitest suite runs with it set;
// asserting it here documents the contract and is harmless if already set by the runner.
process.env.MOT_EMBED_DISABLE = '1';

// Telegram credentials the send path reads at CALL time (env-read-at-call-time). Set before the
// import of lib/notify is not required (they are read inside the function), but set here so the
// happy-path tests below have valid creds.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_USER = '12345';

const { setupTempDb, cleanupTempDb } = await import('./_helpers');
const { sendTelegramNotify } = await import('../../lib/notify');
const { callMcpTool } = await import('../../lib/mcp-tools');

// ── AC-17 — sendTelegramNotify + notify_robin envelope ────────────────────────
describe('Track 7 AC-17 — sendTelegramNotify / notify_robin (extracted helper)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('resolves without throwing when fetch returns a 200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    await expect(sendTelegramNotify('hello')).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws after 3 attempts when every send fails (non-ok response)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(sendTelegramNotify('hello')).rejects.toThrow(
      /delivery failed after 3 attempts/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 attempts when fetch rejects (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as typeof fetch;
    await expect(sendTelegramNotify('hello')).rejects.toThrow(
      /delivery failed after 3 attempts/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws the exact missing-credential message when TELEGRAM_BOT_TOKEN is unset', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await expect(sendTelegramNotify('hello')).rejects.toThrow(
        'notify_robin: TELEGRAM_BOT_TOKEN is not set',
      );
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  it('throws the exact missing-credential message when TELEGRAM_ALLOWED_USER is unset', async () => {
    const saved = process.env.TELEGRAM_ALLOWED_USER;
    delete process.env.TELEGRAM_ALLOWED_USER;
    try {
      await expect(sendTelegramNotify('hello')).rejects.toThrow(
        'notify_robin: TELEGRAM_ALLOWED_USER is not set',
      );
    } finally {
      process.env.TELEGRAM_ALLOWED_USER = saved;
    }
  });

  it('notify_robin MCP case returns the unchanged [{ type:"text", text:"ok" }] envelope', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    const result = await callMcpTool('notify_robin', { text: 'hi' });
    expect(result).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

// ── AC-16 — surfaced_ledger table + UNIQUE (entity_id, horizon_days) ──────────
describe('Track 7 AC-16 — surfaced_ledger migration (0009)', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeAll(() => {
    // setupTempDb applies 0000 base + 0001 FTS. Apply 0009 manually (its DDL is self-contained —
    // no dependency on the intervening hand-written migrations).
    dbPath = setupTempDb('notify-ledger');
    db = new Database(dbPath);
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'db/migrations', '0009_surfaced_ledger.sql'),
      'utf8',
    );
    db.exec(sql);
  });

  afterAll(() => {
    db.close();
    cleanupTempDb(dbPath);
  });

  it('creates the surfaced_ledger table', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='surfaced_ledger'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('surfaced_ledger');
  });

  it('enforces UNIQUE (entity_id, horizon_days) — a duplicate INSERT OR IGNORE writes 0 rows', () => {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO surfaced_ledger (entity_id, horizon_days, surfaced_at) VALUES (?, ?, ?)',
    );
    const first = stmt.run('e1', 7, '2026-07-16T08:00:00Z');
    expect(first.changes).toBe(1);
    const second = stmt.run('e1', 7, '2026-07-16T08:00:00Z');
    expect(second.changes).toBe(0); // UNIQUE constraint fires → ignored

    // A different horizon for the same entity is allowed (the 7 vs 1 bucket distinction).
    const third = stmt.run('e1', 1, '2026-07-16T08:00:00Z');
    expect(third.changes).toBe(1);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM surfaced_ledger WHERE entity_id = ?')
      .get('e1') as { n: number };
    expect(count.n).toBe(2);
  });
});
