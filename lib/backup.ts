import { schedule } from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../db/client';
import { prunePendingProcedural } from './procedural';
import { prunePendingEntities, compactGraph } from './graph-compact';

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
  schedule('0 2 * * *', async () => {
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

    // ── Nightly Recallatron maintenance (Track 4, FR-3.18) ──────────────────────
    // Three steps, each in its OWN try/catch so one failure can't abort the others (AC-9).
    // Order is FIXED: (a) procedural prune → (b) entity prune → (c) compact. Compact MUST run
    // last so freshly-pruned entity records are excluded from the compacted snapshot.

    // (a) Prune stale unconfirmed procedural candidates.
    try {
      const deleted = prunePendingProcedural();
      // eslint-disable-next-line no-console
      console.log(`[MOT/nightly] procedural prune: ${deleted} stale candidate(s) deleted`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] procedural prune failed:', e);
    }

    // (b) Prune stale unconfirmed entity candidates (logs its own [MOT/nightly] count line).
    try {
      prunePendingEntities();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] entity prune failed:', e);
    }

    // (c) Compact graph.jsonl, but only when it has grown past the 5 MB threshold — compaction
    // rewrites the whole file, so it isn't worth doing on a small graph. Runs AFTER (b) so the
    // just-pruned records are absent from the snapshot (FR-3.18).
    try {
      const graphSrc =
        process.env.MOT_GRAPH_PATH ??
        path.join(process.cwd(), 'ontology', 'graph.jsonl');
      const FIVE_MB_LOCAL = 5 * 1024 * 1024; // mirrors FIVE_MB in graph.ts
      let fileSize = 0;
      if (fs.existsSync(graphSrc)) {
        fileSize = fs.statSync(graphSrc).size;
      }
      if (fileSize >= FIVE_MB_LOCAL) {
        await compactGraph(graphSrc);
        // eslint-disable-next-line no-console
        console.log('[MOT/nightly] graph compact: completed');
      } else {
        // eslint-disable-next-line no-console
        console.log('[MOT/nightly] graph compact: skipped (under 5MB threshold)');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] graph compact failed:', e);
    }
  });
  // eslint-disable-next-line no-console
  console.log('[MOT] Nightly backup scheduled (02:00 daily).');
}
