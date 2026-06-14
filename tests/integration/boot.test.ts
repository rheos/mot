import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB client at a throwaway temp file BEFORE importing it, so the singleton
// opens our test DB and not the working ./mot.db. The client reads DATABASE_URL on first
// getDb() call.
const tmpDbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mot-boot-')),
  'boot.db',
);
process.env.DATABASE_URL = tmpDbPath;

// Dynamic import so the env var is set first.
const { getDb } = await import('../../db/client');

describe('DB client boot pragmas (EC-ARCH-1)', () => {
  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = tmpDbPath + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  it('opens in WAL mode', () => {
    const db = getDb();
    const rows = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(rows[0]?.journal_mode).toBe('wal');
  });

  it('sets busy_timeout to 5000ms', () => {
    const db = getDb();
    const rows = db.pragma('busy_timeout') as { timeout: number }[];
    expect(rows[0]?.timeout).toBe(5000);
  });

  it('enforces foreign keys', () => {
    const db = getDb();
    const rows = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(rows[0]?.foreign_keys).toBe(1);
  });
});
