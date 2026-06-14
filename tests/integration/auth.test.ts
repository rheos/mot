import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AC-PRIVATE / AC-VALIDATION (auth path). Drives lib/auth's functions directly against a
// real migrated SQLite DB — no HTTP. The auth module reads DATABASE_URL lazily via getDb(),
// so we point it at a temp DB BEFORE the first import, and migrate that DB by hand.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-auth-'));
const dbPath = path.join(tmpDir, 'auth.db');
process.env.DATABASE_URL = dbPath;

// Apply 0000_init.sql so app_secret exists, then import the module under test.
const migrationsFolder = path.join(process.cwd(), 'db/migrations');
{
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');
  migrate(drizzle(seed), { migrationsFolder });
  seed.close();
}

// Dynamic import after DATABASE_URL + migration are in place.
const { bootstrapApiKey, apiKeyGuard } = await import('../../lib/auth');

function db(): Database.Database {
  return new Database(dbPath);
}

function appSecretCount(): number {
  const conn = db();
  try {
    const row = conn.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as {
      n: number;
    };
    return row.n;
  } finally {
    conn.close();
  }
}

function clearAppSecret(): void {
  const conn = db();
  try {
    conn.prepare('DELETE FROM app_secret').run();
  } finally {
    conn.close();
  }
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrapApiKey lifecycle (FR-AUTH-1)', () => {
  beforeEach(() => {
    clearAppSecret();
    delete process.env.MOT_API_KEY;
  });

  it('first boot seeds a single app_secret row', async () => {
    expect(appSecretCount()).toBe(0);
    process.env.MOT_API_KEY = 'first-boot-key';
    await bootstrapApiKey();
    expect(appSecretCount()).toBe(1);
  });

  it('a re-boot with a MATCHING MOT_API_KEY does not throw and does not overwrite', async () => {
    process.env.MOT_API_KEY = 'stable-key';
    await bootstrapApiKey();
    const conn = db();
    const before = (
      conn.prepare('SELECT key_hash FROM app_secret WHERE id = 1').get() as {
        key_hash: string;
      }
    ).key_hash;
    conn.close();

    // Second boot, same key — must be a no-op (stored hash is authoritative).
    await expect(bootstrapApiKey()).resolves.toBeUndefined();
    expect(appSecretCount()).toBe(1);

    const conn2 = db();
    const after = (
      conn2.prepare('SELECT key_hash FROM app_secret WHERE id = 1').get() as {
        key_hash: string;
      }
    ).key_hash;
    conn2.close();
    expect(after).toBe(before); // never re-hashed / re-seeded
  });

  it('a re-boot with a MISMATCHED MOT_API_KEY throws the FATAL error', async () => {
    process.env.MOT_API_KEY = 'the-real-key';
    await bootstrapApiKey();

    process.env.MOT_API_KEY = 'a-different-key';
    await expect(bootstrapApiKey()).rejects.toThrow(/FATAL: MOT_API_KEY does not match/);
    expect(appSecretCount()).toBe(1); // not overwritten
  });
});

describe('apiKeyGuard (FR-AUTH-1)', () => {
  const KEY = 'guard-test-key';

  beforeEach(async () => {
    clearAppSecret();
    process.env.MOT_API_KEY = KEY;
    await bootstrapApiKey();
  });

  function reqWith(headers: Record<string, string>): Request {
    return new Request('http://localhost/api/tickets', { headers });
  }

  it('returns true for a valid Bearer token', async () => {
    expect(await apiKeyGuard(reqWith({ authorization: `Bearer ${KEY}` }))).toBe(true);
  });

  it('returns false for an invalid token', async () => {
    expect(await apiKeyGuard(reqWith({ authorization: 'Bearer wrong-key' }))).toBe(false);
  });

  it('returns false when the Authorization header is absent', async () => {
    expect(await apiKeyGuard(reqWith({}))).toBe(false);
  });
});
