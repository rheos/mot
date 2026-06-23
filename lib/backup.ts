import { schedule } from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../db/client';

// ── Nightly backup (FR-DB-2, Assumption A8) ───────────────────────────────────
// One job: a WAL-safe point-in-time snapshot of the SQLite DB every night at 02:00.
// VACUUM INTO is the ONLY safe way to copy a live WAL database — `fs.copyFile` on the .db
// file misses the uncheckpointed WAL and can capture a torn page. The retention sweep that
// prunes old snapshots is reserved for Phase 4 (the no-op slot below).

// vacuumInto writes a snapshot named mot-<YYYY-MM-DD>.db into the backup DIRECTORY and returns
// the full destination path. Creates the directory if absent. The single-quote escape guards
// the SQL string literal (the path is local + operator-controlled, but escaping is free).
export function vacuumInto(backupDir: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(backupDir, `mot-${date}.db`);
  fs.mkdirSync(backupDir, { recursive: true });
  getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  // eslint-disable-next-line no-console
  console.log(`[MOT] Backup written: ${dest}`);
  return dest;
}

/**
 * Copy graph.jsonl to backupDir alongside mot.db. If the graph file does not yet exist,
 * log a warning and return — the DB backup must not be interrupted (FR-13, EC-7).
 * Named and exported so it is unit-testable, mirroring vacuumInto.
 */
export function backupGraph(backupDir: string): void {
  const src =
    process.env.MOT_GRAPH_PATH ??
    path.join(process.cwd(), 'ontology', 'graph.jsonl');
  if (!fs.existsSync(src)) {
    // eslint-disable-next-line no-console
    console.warn('[MOT] Graph backup skipped — graph.jsonl not found:', src);
    return;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, 'graph.jsonl');
  fs.copyFileSync(src, dest);
  // eslint-disable-next-line no-console
  console.log(`[MOT] Graph backup written: ${dest}`);
}

// scheduleNightly registers the 02:00 cron job. Started once from instrumentation.ts at boot.
// A failed backup is logged, not thrown — a backup error must never take the server down.
export function scheduleNightly(): void {
  const backupDir = process.env.BACKUP_PATH ?? './backups';
  schedule('0 2 * * *', () => {
    try {
      vacuumInto(backupDir);
      // RETENTION SWEEP SLOT — reserved for Phase 4 (config/retention_policy.ts drives it).
      // retentionSweep(); // <-- Phase 4 fills this in; currently a no-op.
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT] Nightly backup failed:', e);
    }
    // Graph backup runs in its OWN try/catch, AFTER vacuumInto. graph.jsonl is irreplaceable
    // live data alongside mot.db (FR-13); a copy failure here must never abort the DB backup.
    try {
      backupGraph(backupDir);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT] Graph backup failed:', e);
    }
  });
  // eslint-disable-next-line no-console
  console.log('[MOT] Nightly backup scheduled (02:00 daily).');
}
