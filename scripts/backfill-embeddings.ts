// Track 5, Phase 3 — historical embedding backfill (FR 15).
//
// A standalone operator script (run via `tsx`, NOT a Next.js route) that seeds sqlite-vec
// rows for rows that pre-date the inline embed-on-write path, or that missed their inline
// embed (EC 2 recovery). Invoke with:
//   npm run backfill:embeddings -- [--dry-run] [--concurrency N]
//   npx tsx scripts/backfill-embeddings.ts [--dry-run] [--concurrency N]
//
// IDEMPOTENCY IS THIS SCRIPT'S JOB (AC 8): the skip-set for each store is the set of source
// ids ALREADY present in the matching vec table. A row already embedded is skipped, so a
// re-run over a fully-embedded DB is a no-op (0 embedded, 0 errored). Correctness rides on the
// vec tables' PRIMARY KEY: conversation_vec.turn_id / memory_items_vec.item_id (INTEGER) and
// entity_vec.entity_id / session_digest_vec.session_id (TEXT).
//
// FAIL-FAST OPERATOR UX (binding context): the extension / embedder being unavailable is
// reported with a clear message and exit(1), never a crash. --dry-run reports what WOULD embed
// without writing OR downloading the model (no embed() call is made on the dry path).

import path from 'node:path';
import { getDb, migrate_db } from '../db/client';
import { embed, embeddingEnabled, embedderAvailable } from '../lib/embedding';
import { vecInsert, vecReplace, vecAvailable } from '../lib/vec';
import { loadGraph } from '../lib/graph';
import type Database from 'better-sqlite3';

type DB = Database.Database;

const DEFAULT_CONCURRENCY = 5;

export interface BackfillEmbeddingsArgs {
  dryRun: boolean;
  concurrency: number;
}

// Parse Node-style process.argv (tsx provides no CLI arg parser). --concurrency N falls back
// to DEFAULT_CONCURRENCY when absent, non-numeric, or non-positive.
export function parseArgs(argv: string[]): BackfillEmbeddingsArgs {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cIdx = args.indexOf('--concurrency');
  let concurrency = DEFAULT_CONCURRENCY;
  if (cIdx !== -1 && args[cIdx + 1]) {
    const n = Number.parseInt(args[cIdx + 1], 10);
    if (Number.isInteger(n) && n > 0) concurrency = n;
  }
  return { dryRun, concurrency };
}

// Bounded-concurrency runner (inline — no third-party dep). A fixed pool of `limit` workers
// pulls from a shared queue, so at most `limit` embed() calls are ever in flight. This is the
// guardrail that keeps the backfill from saturating a small production host while the app is
// live (EC 10 / FR 15) — never an unbounded Promise.all over every row.
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface StoreItem {
  id: number | string;
  text: string;
}

export interface StoreCounts {
  total: number; // qualifying rows for the store
  skip: number; // already present in the vec table (skip-set hits)
  embedded: number; // rows embedded + written this run (dry-run: rows that WOULD embed)
  errored: number; // embed/write failures (never fatal — logged, counted, run continues)
}

// A store = one vec table plus how to gather its qualifying items, its skip-set, and how to
// write one embedded vector. Order in storeSpecs() is the walk order (FR 15).
interface StoreSpec {
  label: string; // vec table name; also the report key
  idCol: string; // vec table PK column, for the skip-set scan
  items: () => StoreItem[];
  write: (db: DB, id: number | string, f32: Float32Array) => void;
}

// The skip-set: every id already present in a vec table. A plain PK scan of the vec0 table
// (no MATCH — full listing). INTEGER-PK ids read back as JS numbers, TEXT-PK as strings, so a
// Set over the raw values matches the source-row id types directly.
export function vecIdSet(db: DB, table: string, idCol: string): Set<number | string> {
  const rows = db.prepare(`SELECT ${idCol} AS id FROM ${table}`).all() as {
    id: number | string;
  }[];
  return new Set(rows.map((r) => r.id));
}

// The four stores, in walk order (FR 15). Item gathering reads the live DB / graph at call
// time so tests can seed a temp DB + MOT_GRAPH_PATH before invoking.
export function storeSpecs(): StoreSpec[] {
  return [
    // Store 1: conversation — every turn; embed its content.
    {
      label: 'conversation_vec',
      idCol: 'turn_id',
      items: () =>
        (getDb().prepare('SELECT id, content FROM conversation').all() as {
          id: number;
          content: string;
        }[]).map((r) => ({ id: r.id, text: r.content })),
      write: (db, id, f32) => vecInsert(db, 'conversation_vec', id, f32),
    },
    // Store 2: memory_items — active rows only; embed label + reason.
    {
      label: 'memory_items_vec',
      idCol: 'item_id',
      items: () =>
        (getDb()
          .prepare('SELECT id, label, reason FROM memory_items WHERE superseded_by IS NULL')
          .all() as { id: number; label: string; reason: string }[]).map((r) => ({
          id: r.id,
          text: r.label + ' ' + r.reason,
        })),
      write: (db, id, f32) => vecInsert(db, 'memory_items_vec', id, f32),
    },
    // Store 3: session_digest — every digest; embed the summary. vecReplace (INSERT OR REPLACE
    // semantics) keeps re-digest consistency (FR 8 / EC 5); harmless here since the skip-set
    // already excludes present session_ids.
    {
      label: 'session_digest_vec',
      idCol: 'session_id',
      items: () =>
        (getDb().prepare('SELECT session_id, summary FROM session_digest').all() as {
          session_id: string;
          summary: string;
        }[]).map((r) => ({ id: r.session_id, text: r.summary })),
      write: (db, id, f32) => vecReplace(db, 'session_digest_vec', id, f32),
    },
    // Store 4: entity graph — active entities from the folded graph (no superseded ghosts);
    // embed label + serialized properties (mirrors appendEntity's index text in graph.ts).
    {
      label: 'entity_vec',
      idCol: 'entity_id',
      items: () =>
        loadGraph()
          .filter((e) => e.superseded_by === null)
          .map((e) => ({
            id: e.id,
            text: e.label + ' ' + JSON.stringify(e.properties),
          })),
      write: (db, id, f32) => vecInsert(db, 'entity_vec', id, f32),
    },
  ];
}

// Process one store: gather qualifying items, subtract the skip-set, then (real run) embed the
// remainder under bounded concurrency and write each vector. Dry-run computes the same counts
// but writes nothing and calls embed() zero times (so it never triggers a model download).
export async function processStore(
  db: DB,
  spec: StoreSpec,
  opts: { dryRun: boolean; concurrency: number },
): Promise<StoreCounts> {
  const items = spec.items();
  const skipSet = vecIdSet(db, spec.label, spec.idCol);
  const pending = items.filter((it) => !skipSet.has(it.id));

  const counts: StoreCounts = {
    total: items.length,
    skip: items.length - pending.length,
    embedded: 0,
    errored: 0,
  };

  if (opts.dryRun) {
    // Report what a real run WOULD embed; write nothing, embed nothing.
    counts.embedded = pending.length;
    return counts;
  }

  await runWithConcurrency(pending, opts.concurrency, async (it) => {
    try {
      const f32 = await embed(it.text);
      spec.write(db, it.id, f32);
      counts.embedded++;
      if (counts.embedded % 100 === 0) {
        console.log(
          `[backfill-embeddings] ${spec.label}: ${counts.embedded}/${pending.length} embedded`,
        );
      }
    } catch (e) {
      counts.errored++;
      console.error(`[backfill-embeddings] ${spec.label} error on id ${it.id}:`, e);
    }
  });

  return counts;
}

export type BackfillReport = Record<string, StoreCounts>;

// Walk all four stores in order, printing a per-store line as each completes. Returns the full
// report so tests can assert counts without parsing stdout.
export async function runBackfillEmbeddings(opts: {
  dryRun: boolean;
  concurrency: number;
}): Promise<BackfillReport> {
  const db = getDb();
  const report: BackfillReport = {};
  for (const spec of storeSpecs()) {
    const counts = await processStore(db, spec, opts);
    report[spec.label] = counts;
    console.log(
      `${spec.label.padEnd(18)}: total=${counts.total} skip=${counts.skip} ` +
        `embedded=${counts.embedded} errored=${counts.errored}`,
    );
  }
  return report;
}

// The script entry point. Boots the DB + applies migrations (so the vec tables and the
// extension are ready), gates on the extension + embedder, then reports (dry-run) or embeds.
export async function main(argv: string[]): Promise<void> {
  const { dryRun, concurrency } = parseArgs(argv);

  // Boot the DB and apply migrations, same as the app does on start (instrumentation.ts calls
  // migrate_db) and the db:migrate script. getDb() alone only opens the handle + loads the
  // extension; migrate_db() creates the vec tables (0007_vec.sql).
  migrate_db();

  // Gate 1: the sqlite-vec extension. If it didn't load, the vec tables were skipped by the
  // migration (db/client.ts) and there is nothing to write to — fail fast, don't crash later.
  if (!vecAvailable()) {
    console.error(
      '[backfill-embeddings] sqlite-vec extension is not available — vec tables were not ' +
        'created. Cannot backfill. (Set SQLITE_VEC_PATH if the loadable path is non-default.)',
    );
    process.exit(1);
  }

  // Gate 2: embedding must be enabled. This script exists to WRITE embeddings; running it with
  // MOT_EMBED_DISABLE=1 would embed nothing and is always operator error.
  if (!embeddingEnabled()) {
    console.warn(
      '[backfill-embeddings] embedding is disabled (MOT_EMBED_DISABLE=1) — nothing to do. ' +
        'Unset MOT_EMBED_DISABLE and re-run.',
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[backfill-embeddings] dry-run (concurrency ${concurrency}): no rows will be written`);
    await runBackfillEmbeddings({ dryRun: true, concurrency });
    // Return, don't process.exit(0). See the real-run note below — same reason (and dry-run
    // never loads the model, so it drains instantly).
    return;
  }

  // Gate 3 (real run only): the embedder must be able to init. Checked BEFORE the walk so an
  // unusable embedder yields ONE clear message, not one error per row. Skipped on the dry path
  // so a report never pays the ~90MB model download.
  if (!(await embedderAvailable())) {
    console.error(
      '[backfill-embeddings] the embedding model is unavailable (init/download failed). ' +
        'Confirm the boot warm-up completed and .model-cache is populated, then re-run.',
    );
    process.exit(1);
  }

  console.log(`[backfill-embeddings] real run (concurrency ${concurrency})`);
  const report = await runBackfillEmbeddings({ dryRun: false, concurrency });

  // Partial failure must be visible to the shell: the SSH operator checks $?. Per-row errors
  // are logged + counted (never fatal mid-run), so surface them here as a non-zero exit.
  // ASSIGN process.exitCode — do NOT call process.exit(), which re-introduces the SIGABRT
  // described below. Node drains the threadpool first, then exits 1.
  const totalErrored = Object.values(report).reduce((n, c) => n + c.errored, 0);
  if (totalErrored > 0) {
    console.error(
      `[backfill-embeddings] completed with ${totalErrored} errored row(s) — ` +
        'see errors above; a re-run retries only the failed rows (skip-set).',
    );
    process.exitCode = 1;
  }

  // DELIBERATELY no process.exit(0). fastembed loads onnxruntime-node, whose native
  // threadpool aborts (SIGABRT: "mutex lock failed") if process.exit() tears it down while
  // its threads are live. Returning lets Node drain the idle threadpool and exit cleanly
  // (0, or 1 via the exitCode assignment above). The gate paths keep process.exit(1)
  // because they run BEFORE any model load.
}

// Run only when executed directly (tsx scripts/backfill-embeddings.ts), never on import — so
// the tests can import the helpers above without booting the DB or tripping process.exit.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).includes('backfill-embeddings');
}

if (isDirectRun()) {
  (async () => {
    await main(process.argv);
  })().catch((e) => {
    console.error('[backfill-embeddings] fatal:', e);
    process.exit(1);
  });
}
