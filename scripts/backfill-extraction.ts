// Recallatron Phase 3 — historical backfill (Track 4, Prompt 5).
//
// A standalone operator script (run via `tsx`, NOT a Next.js route) that runs entity + procedural
// extraction over pre-Track-2 `session_digest` rows. Invoke with:
//   npm run backfill -- [--dry-run] [--before <ISO>]
//   npx tsx scripts/backfill-extraction.ts [--dry-run] [--before <ISO>]
//
// GAP #2 — IDEMPOTENCY IS THIS SCRIPT'S JOB:
// `runExtraction` is NOT idempotent for entities. `processEntities` calls `appendEntity(...)`
// unconditionally for every item that clears the confidence gate (extraction.ts:148), and
// `appendEntity` mints a fresh id via createId() on every call (graph.ts:66) — the Levenshtein scan
// only sets `probable_duplicate_of`, it does NOT skip the append. So a naive re-run re-appends every
// passing entity as a brand-new duplicate. Procedural notes alone ARE internally idempotent
// (insertCandidate skips on note_norm collision, procedural.ts:43-46).
//
// Entity idempotency is therefore enforced here by a digest-level skip-set: `graphEntitySources`
// (lib/graph-compact.ts) returns every entity `source` already in graph.jsonl, status-agnostic.
// Every extraction-pass entity is sourced `session:${session_id}` (extraction.ts:154), so a digest
// whose `session:<id>` source is already in the set has already been extracted and is skipped.

import path from 'node:path';
import { getDb, migrate_db } from '../db/client';
import type { DigestRow } from '../lib/digest';
import { runExtraction } from '../lib/extraction';
import { graphEntitySources } from '../lib/graph-compact';

const DEFAULT_BEFORE = '2026-06-22';

export interface BackfillArgs {
  dryRun: boolean;
  beforeDate: string;
}

// Parse Node-style process.argv (tsx provides no CLI arg parser). Defaults beforeDate to
// DEFAULT_BEFORE when --before is absent or has no value.
export function parseArgs(argv: string[]): BackfillArgs {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const beforeIdx = args.indexOf('--before');
  const beforeDate =
    beforeIdx !== -1 && args[beforeIdx + 1] ? args[beforeIdx + 1] : DEFAULT_BEFORE;
  return { dryRun, beforeDate };
}

// The live graph path (graph.ts:49 expression). Resolved at call time so tests can redirect via
// MOT_GRAPH_PATH and the real ontology/graph.jsonl is never touched.
function graphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

// The qualifying rows: parse_error = 0 (integer comparison — DigestRow.parse_error is number,
// digest.ts:25) and ts < beforeDate (SQLite text comparison; ts is stored as an ISO string).
export function qualifyingRows(beforeDate: string): DigestRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM session_digest WHERE parse_error = 0 AND ts < ?`)
    .all(beforeDate) as DigestRow[];
}

export interface DryRunCounts {
  qualifying: number;
  actionable: number; // rows with entity_draft OR procedural_raw (the real curation work)
  structural: number; // structural-only rows that will no-op
  alreadyExtracted: number; // skip-set hits (GAP #2)
  netNew: number; // qualifying minus alreadyExtracted
}

// The dry-run counting logic, extracted so AC-10 can assert it directly without a subprocess.
// Pure over (rows, skip-set): never writes.
export function dryRunCounts(rows: DigestRow[], extractedSources: Set<string>): DryRunCounts {
  const actionable = rows.filter(
    (r) => r.entity_draft !== null || r.procedural_raw !== null,
  ).length;
  const alreadyExtracted = rows.filter((r) =>
    extractedSources.has(`session:${r.session_id}`),
  ).length;
  return {
    qualifying: rows.length,
    actionable,
    structural: rows.length - actionable,
    alreadyExtracted,
    netNew: rows.length - alreadyExtracted,
  };
}

export interface RealRunTally {
  processed: number;
  skippedAlreadyExtracted: number;
  errored: number;
  qualifying: number;
}

// The real-run loop, extracted so AC-11 can drive it directly (and re-run it) without spawning a
// subprocess or tripping process.exit. Serial is safe and sufficient for a one-off (OQ-7). The
// skip-set is read ONCE by the caller before the loop: each digest is visited once, so entities
// appended during this run are never re-checked within the same run.
export async function runBackfill(
  rows: DigestRow[],
  extractedSources: Set<string>,
): Promise<RealRunTally> {
  let processed = 0;
  let errored = 0;
  let skippedAlreadyExtracted = 0;

  for (const row of rows) {
    const srcKey = `session:${row.session_id}`;
    if (extractedSources.has(srcKey)) {
      skippedAlreadyExtracted++;
      console.log(`[backfill] skip (already-extracted): session ${row.session_id}`);
      continue;
    }
    try {
      await runExtraction(row);
      processed++;
      if (processed % 10 === 0 || processed === rows.length) {
        console.log(
          `[backfill] progress: ${processed} processed (of ${rows.length} qualifying)`,
        );
      }
    } catch (e) {
      errored++;
      console.error(`[backfill] error on session ${row.session_id}:`, e);
    }
  }

  return { processed, skippedAlreadyExtracted, errored, qualifying: rows.length };
}

// The script entry point. Boots the DB (getDb runs migrations on first open — db/client.ts), reads
// the qualifying rows and the skip-set, then either reports (dry-run) or processes (real run).
export async function main(argv: string[]): Promise<void> {
  const { dryRun, beforeDate } = parseArgs(argv);

  // Boot the DB and apply migrations, same as the app does on start (instrumentation.ts calls
  // migrate_db) and the db:migrate script. getDb() alone only opens the handle — it does NOT run
  // migrations, so on a fresh/separate DB the session_digest table would be missing.
  migrate_db();
  const rows = qualifyingRows(beforeDate);

  // Build the skip-set ONCE, before any processing (GAP #2 idempotency primitive).
  const extractedSources = graphEntitySources(graphPath());

  if (dryRun) {
    const c = dryRunCounts(rows, extractedSources);
    console.log(`[backfill] dry-run: ${c.qualifying} qualifying rows (before ${beforeDate})`);
    console.log(
      `[backfill] dry-run: ${c.actionable} rows have entity_draft or procedural_raw`,
    );
    console.log(
      `[backfill] dry-run: ${c.structural} rows are structural-only (will no-op)`,
    );
    console.log(
      `[backfill] dry-run: ${c.alreadyExtracted} rows already extracted (skip-set), ${c.netNew} net-new`,
    );
    process.exit(0);
  }

  const tally = await runBackfill(rows, extractedSources);
  console.log(
    `[backfill] done: ${tally.processed} processed, ` +
      `${tally.skippedAlreadyExtracted} skipped (already-extracted), ` +
      `${tally.errored} errored, of ${tally.qualifying} qualifying rows`,
  );
  process.exit(0);
}

// Run only when executed directly (tsx scripts/backfill-extraction.ts), never on import — so the
// tests can import the helpers above without booting the DB or tripping process.exit. The guard
// compares the resolved entry-point path to this module's path (works under tsx/ESM and CJS).
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // import.meta.url is a file:// URL; argv[1] is a filesystem path. Compare basenames + dir to be
  // robust across tsx's loader without pulling in url.fileURLToPath edge cases.
  return path.resolve(entry).includes('backfill-extraction');
}

if (isDirectRun()) {
  (async () => {
    await main(process.argv);
  })().catch((e) => {
    console.error('[backfill] fatal:', e);
    process.exit(1);
  });
}
