import { describe, it, expect, afterAll, vi } from 'vitest';
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
const { vacuumInto, backupGraph } = await import('../../lib/backup');

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

// FR-13 / EC-7 — backupGraph copies graph.jsonl alongside mot.db. graph.jsonl is irreplaceable
// live data (gitignored, same class as mot.db); the nightly backup must include it. A missing
// graph file is a no-op (warn + return), never an error — it must not interrupt the DB backup.

describe('FR-13 — backupGraph nightly graph snapshot', () => {
  afterAll(() => {
    delete process.env.MOT_GRAPH_PATH;
  });

  it('AC-9a: copies graph.jsonl from MOT_GRAPH_PATH into backupDir, content intact', () => {
    const graphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-src-'));
    const graphSrc = path.join(graphDir, 'graph.jsonl');
    const content = '{"id":"e1","label":"Taylor"}\n{"id":"e2","label":"SampleApp"}\n';
    fs.writeFileSync(graphSrc, content);
    process.env.MOT_GRAPH_PATH = graphSrc;

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-dest-'));
    try {
      backupGraph(dest);
      const copied = path.join(dest, 'graph.jsonl');
      expect(fs.existsSync(copied)).toBe(true);
      expect(fs.readFileSync(copied, 'utf8')).toBe(content);
    } finally {
      fs.rmSync(graphDir, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('AC-9b (EC-7): missing graph.jsonl → no-op (warns, no dest written, no throw)', () => {
    process.env.MOT_GRAPH_PATH = path.join(os.tmpdir(), 'mot-graph-does-not-exist', 'graph.jsonl');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-dest-missing-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => backupGraph(dest)).not.toThrow();
      expect(fs.existsSync(path.join(dest, 'graph.jsonl'))).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
