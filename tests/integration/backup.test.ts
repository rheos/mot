import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// FR-DB-2 — the nightly backup mechanism. vacuumInto() writes a WAL-safe snapshot of the live
// DB into the backup directory. The snapshot must be a complete, openable SQLite DB that
// carries the rows present at backup time. (cp on a live WAL DB would NOT guarantee this — the
// reason VACUUM INTO is mandated.)

const dbPath = setupTempDb('backup');
const { createTicket } = await import('../../lib/tickets');
const { vacuumInto } = await import('../../lib/backup');

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-backup-dest-'));

afterAll(() => {
  cleanupTempDb(dbPath);
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('FR-DB-2 — vacuumInto nightly backup', () => {
  it('writes a valid, non-empty SQLite snapshot carrying the live rows', () => {
    // Seed one ticket into the live DB.
    createTicket(createInput({ title: 'Backed up' }) as never);

    // Run the backup.
    const dest = vacuumInto(backupDir);

    // File exists at the dated path and is non-empty.
    const date = new Date().toISOString().slice(0, 10);
    expect(dest).toBe(path.join(backupDir, `mot-${date}.db`));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);

    // The snapshot opens as SQLite and carries the seeded row.
    const snap = new Database(dest, { readonly: true });
    try {
      const { n } = snap.prepare('SELECT COUNT(*) AS n FROM ticket').get() as {
        n: number;
      };
      expect(n).toBe(1);
    } finally {
      snap.close();
    }
  });
});
