import { schedule } from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../db/client';
import { compactGraph } from './graph-compact';
import { resolutionWorker, dedupWorker, autoconfirmWorker } from './maintainer';
import { profileWorker } from './profile';
import { runSurfacing } from './surfacing';
// NOTE: prunePendingProcedural / prunePendingEntities are intentionally NOT imported here anymore.
// The nightly job no longer disuse-prunes memories — persistence is a hard product requirement
// (a fact the user stated once must survive indefinitely, even if never referenced again). The prune
// functions still exist in ./procedural and ./graph-compact for explicit, non-disuse cleanup, but
// they are not wired into the cron. See memory: memory-system-ambient-not-administered.

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

    // ── Nightly Recallatron maintenance ─────────────────────────────────────────
    // DISUSE PRUNE REMOVED (2026-07-08). The old job ran (a) procedural prune → (b) entity prune
    // before compacting: both deleted unconfirmed, lower-confidence memory candidates after 30
    // days of NON-USE. That is exactly the use-or-lose decay this system must NOT do — persistence
    // is the core promise (state it once, keep it forever, even if never referenced again).
    // Only compaction runs now, and compaction is safe for persistence: it drops ONLY records that
    // were explicitly superseded/corrected (superseded_by !== null), never records that were merely
    // unused. Quality control belongs at extraction; wrong memories are fixed by correction, not by
    // disuse-deletion. See memory: memory-system-ambient-not-administered.

    // Compact graph.jsonl, but only when it has grown past the 5 MB threshold — compaction
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

    // ── Recallatron Maintainer — resolution + dedup + autoconfirm + profile workers ──
    // All run LIVE (dryRun:false). Each in its OWN try/catch so one worker's failure never
    // blocks the other or the rest of the nightly job (FR-12/AC-10). The env short-circuits
    // (MAINTAINER_*_DISABLE='1') let the operator turn a worker off without a deploy (FR-14/AC-7):
    // one log line, NO worker call, NO write. Sequence so far:
    //   vacuumInto → backupGraph → [compact if ≥5MB] → resolution → dedup → autoconfirm → profile.
    try {
      if (process.env.MAINTAINER_RESOLUTION_DISABLE === '1') {
        // eslint-disable-next-line no-console
        console.log('[MOT/maintainer] resolution worker disabled — skipping');
      } else {
        await resolutionWorker({ dryRun: false });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] resolution worker failed:', e);
    }

    try {
      if (process.env.MAINTAINER_DEDUP_DISABLE === '1') {
        // eslint-disable-next-line no-console
        console.log('[MOT/maintainer] dedup worker disabled — skipping');
      } else {
        await dedupWorker({ dryRun: false });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] dedup worker failed:', e);
    }

    // Auto-confirm runs AFTER dedup (never confirm an entity about to be merged away) and BEFORE
    // profile (a promoted entity feeds the profile's confirmed-gated synthesis on the same pass).
    try {
      if (process.env.MAINTAINER_AUTOCONFIRM_DISABLE === '1') {
        // eslint-disable-next-line no-console
        console.log('[MOT/maintainer] autoconfirm worker disabled — skipping');
      } else {
        autoconfirmWorker({ dryRun: false });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] autoconfirm worker failed:', e);
    }

    try {
      if (process.env.MAINTAINER_PROFILE_DISABLE === '1') {
        // eslint-disable-next-line no-console
        console.log('[MOT/maintainer] profile worker disabled — skipping');
      } else {
        profileWorker({ dryRun: false });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MOT/nightly] profile worker failed:', e);
    }
  });

  // ── Track 7 — Proactive surfacing (SEPARATE daytime cron; FR-1/FR-10/D3) ─────
  // A SECOND schedule() so surfacing sends in the morning, NOT at 02:00 UTC. Its own try/catch
  // (mirroring the maintainer workers) isolates a surfacing failure from the rest of the job.
  // The 02:00 cron above is UNCHANGED (no surfacing step added there).
  //
  // The third `{ timezone }` arg is LOAD-BEARING: the prod box runs UTC, so without it
  // '0 8 * * *' would fire at 08:00 UTC (≈ 00:00–01:00 Pacific — INSIDE the 21:00–08:00 quiet
  // window) and runSurfacing's quiet-hours guard would silently defer every send forever. With
  // it, the cron fires at SURFACING_SEND_HOUR in SURFACING_TZ (default 08:00 America/Vancouver).
  // Both SURFACING_SEND_HOUR and SURFACING_TZ are read HERE at schedule-registration time (boot);
  // changing either needs a service restart, identical to how the 02:00 expression is fixed at boot.
  const sendHour = (() => {
    const h = Number.parseInt(process.env.SURFACING_SEND_HOUR ?? '', 10);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
  })();
  const surfacingTz = process.env.SURFACING_TZ ?? 'America/Vancouver';
  schedule(
    `0 ${sendHour} * * *`,
    async () => {
      try {
        await runSurfacing({ dryRun: false });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[MOT/surfacing] cron failed:', e);
      }
    },
    { timezone: surfacingTz },
  );

  // eslint-disable-next-line no-console
  console.log(
    `[MOT] Nightly backup scheduled (02:00 UTC daily); surfacing scheduled (${sendHour}:00 Pacific daily).`,
  );
}
