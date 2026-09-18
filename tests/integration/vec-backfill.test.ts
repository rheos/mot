import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { setupVecDb, cleanupTempDb } from './_helpers';

// ── Track 5 / Phase 3 — historical embedding backfill integration tests ──────────────
// Exercises scripts/backfill-embeddings.ts by IMPORTING its functions (not spawning tsx) —
// same shape as backfill-extraction.test.ts. Proves AC 8: --dry-run reports what WOULD embed
// while writing nothing, and a re-run over an already-embedded DB is a no-op (idempotency via
// the per-store skip-set). AC 10 (the skipIf guard) is proven structurally by the guard itself.
//
// Same opt-in harness as vec-write.test.ts / vec-retrieval.test.ts (the two other files that
// embed for real):
//   (a) delete MOT_EMBED_DISABLE at module top — env is read lazily per call, so this opts the
//       whole file back in to real embedding; RESTORED to '1' in afterAll.
//   (b) setupVecDb builds the temp DB WITH the four vec0 tables and points DATABASE_URL at it,
//       before the dynamic imports that reach getDb() lazily.
//   (c) skip cleanly (describe.skipIf) when the extension can't load OR the embedder can't init —
//       an extension-missing box and a model-unfetchable box both skip, never partially fail (AC 10).

// (a) Opt back in to embedding for this file only.
delete process.env.MOT_EMBED_DISABLE;

// (b) setupVecDb creates the temp DB (with vec tables when the extension loads) and sets
// DATABASE_URL. Run BEFORE the dynamic imports below (getDb reads DATABASE_URL lazily).
const { dbPath, vecAvail } = setupVecDb('backfill-embeddings');

// The entity store (store 4) walks loadGraph(), which reads MOT_GRAPH_PATH lazily. Point it at a
// temp file in the same dir so the real ontology/graph.jsonl is never touched (no entities are
// seeded here, so the graph stays empty and store 4 has nothing to embed).
const graphFile = path.join(path.dirname(dbPath), 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

// Dynamic imports AFTER DATABASE_URL is set.
const { vecAvailable } = await import('../../lib/vec');
const { embedderAvailable } = await import('../../lib/embedding');
const { getDb } = await import('../../db/client');
const { parseArgs, runBackfillEmbeddings } = await import('../../scripts/backfill-embeddings');

// Warm the app connection so loadVecExtension runs on it too — vecAvailable() is then
// authoritative for the skip guard (the seed proved loadability; this proves the app handle agrees).
let appVecOk = false;
if (vecAvail) {
  try {
    getDb();
    appVecOk = vecAvailable();
  } catch {
    appVecOk = false;
  }
}

// (c) Only pay the ~90MB model init when we can actually run — otherwise skip cleanly (AC 10).
const embedderOk = appVecOk ? await embedderAvailable() : false;
const SKIP = !appVecOk || !embedderOk;

const TEST_TIMEOUT = 30_000;

afterAll(() => {
  // Restore the suite-wide embed-off default from vitest.config.ts.
  process.env.MOT_EMBED_DISABLE = '1';
  delete process.env.MOT_GRAPH_PATH;
  try {
    getDb().close();
  } catch {
    /* never opened / already closed */
  }
  cleanupTempDb(dbPath);
});

// ── helpers ─────────────────────────────────────────────────────────────────────
function vecRowCount(table: string): number {
  return (getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function vecCount(table: string, idCol: string, id: number | string): number {
  return (
    getDb().prepare(`SELECT count(*) AS n FROM ${table} WHERE ${idCol} = ?`).get(id) as {
      n: number;
    }
  ).n;
}

// Seed a conversation turn via RAW INSERT — no logTurn ⇒ NO inline embed. This models a row that
// pre-dates (or missed) the inline embed path, which is exactly the population the backfill exists
// to recover (mirrors vec-write.test.ts TEST 6's raw seed to avoid a stray conversation embed).
function seedTurn(content: string): number {
  const r = getDb()
    .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?,?,?,?,?)`)
    .run('bf-chat', 'bf-session', 'user', content, new Date().toISOString());
  return r.lastInsertRowid as number;
}

// Seed an active memory_items row via RAW INSERT — no writeMemory ⇒ NO inline embed. source_turn_id
// FKs conversation(id) (foreign_keys=ON on the app handle), so it takes a real turn id.
function seedMemory(turnId: number, label: string, reason: string): number {
  const r = getDb()
    .prepare(
      `INSERT INTO memory_items
         (type, label, label_norm, properties, chat_id, source_turn_id, source_session_id, confidence, reason, ts)
       VALUES ('fact', ?, ?, '{}', 'bf-chat', ?, 'bf-session', 0.9, ?, ?)`,
    )
    .run(label, label.toLowerCase(), turnId, reason, new Date().toISOString());
  return r.lastInsertRowid as number;
}

// ── parseArgs lives OUTSIDE the skip: no DB, no embedder needed ────────────────────────
// Doubles as AC 10's "trivial test that always passes outside the skipIf block" — it proves the
// test file (and the script module) load even when the extension/embedder are absent.
describe('scripts/backfill-embeddings — parseArgs', () => {
  it('defaults to a real run at DEFAULT_CONCURRENCY when no flags are passed', () => {
    // parseArgs slices argv[2:] (Node-style: [node, script, ...flags]).
    expect(parseArgs(['node', 'backfill-embeddings'])).toEqual({ dryRun: false, concurrency: 5 });
  });

  it('parses --dry-run and --concurrency N', () => {
    expect(parseArgs(['node', 'backfill-embeddings', '--dry-run'])).toEqual({
      dryRun: true,
      concurrency: 5,
    });
    expect(parseArgs(['node', 'backfill-embeddings', '--concurrency', '3']).concurrency).toBe(3);
    // Non-positive / non-numeric concurrency falls back to the default.
    expect(parseArgs(['node', 'backfill-embeddings', '--concurrency', '0']).concurrency).toBe(5);
    expect(parseArgs(['node', 'backfill-embeddings', '--concurrency', 'abc']).concurrency).toBe(5);
  });
});

// ── AC 10: the whole block skips cleanly when vec/embedder are unavailable ──────────────
// Structural proof — when SKIP is true (extension missing OR model unfetchable), vitest reports
// every test below as 'skipped', never 'failed'. No partial run, no false red.
describe.skipIf(SKIP)('scripts/backfill-embeddings — backfill (AC 8)', () => {
  it(
    'TEST 1 — --dry-run reports would-embed counts and writes NOTHING',
    async () => {
      const turnId = seedTurn('dry-run conversation turn to embed');
      const memId = seedMemory(turnId, 'dry run memory label', 'dry run reason');

      // OVERRIDE (handoff): the prompt's literal parseArgs(['--dry-run']) does NOT set dryRun —
      // parseArgs slices argv[2:], so the flag must sit at index >= 2. Pass a real Node argv.
      expect(parseArgs(['node', 'backfill-embeddings', '--dry-run']).dryRun).toBe(true);

      const convBefore = vecRowCount('conversation_vec');
      const memBefore = vecRowCount('memory_items_vec');

      const report = await runBackfillEmbeddings({ dryRun: true, concurrency: 5 });

      // The report shows what a REAL run would embed. OVERRIDE (handoff): the shipped StoreCounts
      // sets dry-run `embedded` = pending.length (would-embed), NOT 0 — the "writes nothing"
      // guarantee is the DB-row check below, not the report field.
      expect(report.conversation_vec.total).toBeGreaterThan(0);
      expect(report.conversation_vec.skip).toBe(0); // nothing embedded yet ⇒ empty skip-set
      expect(report.conversation_vec.embedded).toBe(report.conversation_vec.total); // all pending
      expect(report.conversation_vec.errored).toBe(0);

      expect(report.memory_items_vec.total).toBeGreaterThan(0);
      expect(report.memory_items_vec.skip).toBe(0);
      expect(report.memory_items_vec.embedded).toBe(report.memory_items_vec.total);
      expect(report.memory_items_vec.errored).toBe(0);

      // The load-bearing AC-8 assertion: dry-run wrote NOTHING to any vec table.
      expect(vecRowCount('conversation_vec')).toBe(convBefore);
      expect(vecRowCount('memory_items_vec')).toBe(memBefore);
      expect(vecCount('conversation_vec', 'turn_id', turnId)).toBe(0);
      expect(vecCount('memory_items_vec', 'item_id', memId)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 2 — a real run embeds; re-running over the same DB is a no-op (idempotency)',
    async () => {
      const turnId = seedTurn('idempotency conversation turn');

      // First real run: embeds every not-yet-embedded row (this turn + TEST 1's rows, which the
      // dry-run left unwritten — so they are still pending on this shared per-file DB).
      const first = await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });
      expect(first.conversation_vec.errored).toBe(0);
      expect(first.memory_items_vec.errored).toBe(0);
      // The seeded row is now embedded — proves the write path actually ran, not just the counters.
      expect(vecCount('conversation_vec', 'turn_id', turnId)).toBe(1);

      const convRows = vecRowCount('conversation_vec');
      const memRows = vecRowCount('memory_items_vec');

      // Second run: the skip-set now holds every id, so nothing re-embeds (AC 8 idempotency).
      // OVERRIDE (handoff): asserted as a full no-op across all stores rather than the prompt's
      // absolute "0 embedded, skip=1" — the per-file DB persists TEST 1's rows, so absolute counts
      // don't hold; the delta (nothing new embedded, row counts unchanged) is the honest proof.
      const second = await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });
      for (const [label, store] of Object.entries(second)) {
        expect(store.embedded, `${label} must embed nothing on the re-run`).toBe(0);
        expect(store.errored, `${label} must not error on the re-run`).toBe(0);
        expect(store.skip, `${label}: every qualifying row must be skipped`).toBe(store.total);
      }
      // Row counts unchanged — the re-run inserted no duplicate vectors.
      expect(vecRowCount('conversation_vec')).toBe(convRows);
      expect(vecRowCount('memory_items_vec')).toBe(memRows);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 5 (issue #30) — a stale-representation row is RE-embedded, not skipped',
    async () => {
      // Get every row current first, so the only pending work below is what we deliberately stale.
      await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });

      const turnId = seedTurn('a turn whose vector predates the current embed representation');
      await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });
      expect(vecCount('conversation_vec', 'turn_id', turnId)).toBe(1);

      // Simulate a row written before 0010 existed: the vector is there, the stamp is not.
      // vecStaleIds must treat absent metadata as representation 1 (see 0010_embed_version.sql).
      getDb().prepare('DELETE FROM vec_meta WHERE table_name = ? AND row_id = ?')
        .run('conversation_vec', String(turnId));

      const rowsBefore = vecRowCount('conversation_vec');
      const run = await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });

      // Counted as restale (present but outdated), embedded, and NOT skipped.
      expect(run.conversation_vec.restale).toBe(1);
      expect(run.conversation_vec.embedded).toBe(1);
      expect(run.conversation_vec.errored).toBe(0);

      // vecReplace semantics: re-embedded in place, so no duplicate vector row appeared.
      expect(vecRowCount('conversation_vec')).toBe(rowsBefore);
      expect(vecCount('conversation_vec', 'turn_id', turnId)).toBe(1);

      // The stamp is restored, so a further run is a no-op again.
      const after = await runBackfillEmbeddings({ dryRun: false, concurrency: 5 });
      expect(after.conversation_vec.restale).toBe(0);
      expect(after.conversation_vec.embedded).toBe(0);
    },
    TEST_TIMEOUT,
  );

  // TEST 3 — AC 10 (skipIf guard proven): there is no explicit assertion here. When the sqlite-vec
  // extension can't load OR the embedder can't init, SKIP is true and vitest marks THIS ENTIRE
  // describe block 'skipped' (never 'failed'). The always-run parseArgs block above confirms the
  // file itself still loads with the extension absent. Together they satisfy AC 10.
});
