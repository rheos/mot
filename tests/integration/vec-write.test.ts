import { describe, it, expect, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Track 5 / Phase 1 — vec write-path integration tests ────────────────────────
// Every OTHER integration test runs with MOT_EMBED_DISABLE=1 (vitest.config.ts), so no model
// download and no vec write ever fires for them (AC 1). This file is one of the THREE that opt
// back in to real embedding (with vec-retrieval.test.ts and vec-backfill.test.ts). It proves
// every write path lands a row in its vec0 table plus the
// two prune paths (memory supersede, entity compaction) and the EMBED_INLINE=false deferred
// sweep. It self-configures three things ordinary tests don't:
//   (a) delete MOT_EMBED_DISABLE at module top — env is read lazily per call, so this opts in;
//       RESTORED in afterAll (safe under vitest fork-per-file isolation, required if a fork is
//       ever reused across files).
//   (b) load the sqlite-vec extension into the SEED connection before 0007_vec.sql runs, so the
//       CREATE VIRTUAL TABLE ... USING vec0 statements succeed.
//   (c) skip cleanly (describe.skipIf) when the extension can't load OR the embedder can't init —
//       an extension-missing box and a model-unfetchable box both skip, never partially fail
//       (AC 10). The ~90MB model download into ./.model-cache is expected on first run.

// (a) Opt back in to embedding for this file only.
delete process.env.MOT_EMBED_DISABLE;

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-vec-write-'));
const dbPath = path.join(tmpDir, 'vec.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');

// Set env BEFORE any dynamic import that reaches getDb() / graphPath().
process.env.DATABASE_URL = dbPath;
process.env.MOT_GRAPH_PATH = graphFile;

// Seed connection. (b) Load the vec extension first, then apply migrations. If the extension
// can't load on this platform, DON'T create the vec tables and let the whole describe skip
// (vecReady=false) — never crash module evaluation.
let vecReady = false;
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
try {
  const vecPath = process.env.SQLITE_VEC_PATH ?? getLoadablePath();
  seed.loadExtension(vecPath);
  vecReady = true;
} catch (err) {
  console.warn('[vec-write.test] sqlite-vec unavailable — tests will skip:', (err as Error).message);
}

// drizzle-tracked base schema (conversation, memory_items, session_digest, …).
migrate(drizzle(seed), { migrationsFolder });
// Hand-written migrations drizzle doesn't track — same set + order as applyHandWrittenMigrations
// in db/client.ts. 0007_vec.sql runs only when the extension loaded (else CREATE VIRTUAL TABLE
// would throw and abort setup).
for (const f of [
  '0001_fts.sql',
  '0003_conversation_fts.sql',
  '0004_topic_threads.sql',
  '0005_procedural_notes.sql',
  '0006_memory_fts.sql',
  '0008_relation_draft.sql', // Track 6 — adds session_digest.relation_draft (no vec dep)
  '0010_embed_version.sql', // vec_meta — vecInsert/vecReplace/vecDelete write it (no vec dep)
  '0011_tool_call_log.sql', // tool_call_log — callMcpTool records every dispatch (no vec dep)
]) {
  seed.exec(fs.readFileSync(path.join(migrationsFolder, f), 'utf8'));
}
if (vecReady) {
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0007_vec.sql'), 'utf8'));
}
seed.close();

// Dynamic imports AFTER DATABASE_URL is set (getDb reads it lazily; mirrors the other
// integration tests' ordering constraint).
const { vecAvailable } = await import('../../lib/vec');
const { embedderAvailable } = await import('../../lib/embedding');
const { getDb } = await import('../../db/client');
const { logTurn } = await import('../../lib/conversation');
const { writeMemory } = await import('../../lib/memory');
const { appendEntity, appendSupersede } = await import('../../lib/graph');
const { upsertDigest } = await import('../../lib/digest');
const { compactGraph } = await import('../../lib/graph-compact');

// Warm the app connection so loadVecExtension runs on it too, making vecAvailable() authoritative
// for the skip guard (the seed proved loadability; this proves the app handle agrees).
let appVecOk = false;
if (vecReady) {
  try {
    getDb();
    appVecOk = vecAvailable();
  } catch {
    appVecOk = false;
  }
}

// Only pay the ~90MB model init when we're actually going to run — otherwise skip cleanly (AC 10).
const embedderOk = vecReady && appVecOk ? await embedderAvailable() : false;
const SKIP = !vecReady || !appVecOk || !embedderOk;

afterAll(() => {
  // Restore the suite-wide embed-off default from vitest.config.ts.
  process.env.MOT_EMBED_DISABLE = '1';
  delete process.env.EMBED_INLINE;
  delete process.env.MOT_GRAPH_PATH;
  try {
    getDb().close();
  } catch {
    /* never opened / already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────────
type Id = number | string;

// Point count on a vec0 primary key. vec0 supports WHERE <pk> = ? (same access pattern
// vecDelete uses), so no MATCH is needed.
function vecCount(table: string, idCol: string, id: Id): number {
  const row = getDb()
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${idCol} = ?`)
    .get(id) as { n: number };
  return row.n;
}

// writeMemory returns MemoryRow | { conflict, new } | { error }. Pull the new row id, failing
// loudly on the error variant.
function writtenId(res: ReturnType<typeof writeMemory>): number {
  if ('error' in res) throw new Error(`writeMemory error: ${res.error}`);
  return 'conflict' in res ? res.new.id : res.id;
}

// vi.waitFor budget for a fire-and-forget embed+insert to settle. The model is warmed at module
// top, so a warm embed is ~tens of ms; 8s is a generous CPU ceiling.
const WAIT = { timeout: 8_000, interval: 100 };
// Per-test timeout must exceed the waitFor ceiling (default testTimeout is 5s).
const TEST_TIMEOUT = 20_000;
// Plain sleep for NEGATIVE assertions (proving a row stays ABSENT — cannot be polled for).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(SKIP)('Track 5 — vec write paths', () => {
  it(
    'TEST 1 — logTurn populates conversation_vec (AC 5)',
    async () => {
      const turn = logTurn('vec-chat-1', 'user', 'hello world');
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', turn.id)).toBe(1);
      }, WAIT);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 2 — writeMemory populates memory_items_vec (AC 5)',
    async () => {
      const turn = logTurn('vec-chat-2', 'user', 'a turn to hang a memory on');
      const res = writeMemory({
        type: 'fact',
        content: { label: 'test fact', properties: {} },
        source_turn_id: turn.id,
        source_session_id: turn.session_id,
        confidence: 0.9,
        reason: 'test reason',
      });
      const id = writtenId(res);
      await vi.waitFor(() => {
        expect(vecCount('memory_items_vec', 'item_id', id)).toBe(1);
      }, WAIT);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 3 — memory supersede prunes the old vec row and indexes the new one (W3)',
    async () => {
      const turn = logTurn('vec-chat-3', 'user', 'a turn shared by two memory versions');
      const first = writeMemory({
        type: 'fact',
        content: { label: 'shared memory', properties: { a: 1 } },
        source_turn_id: turn.id,
        source_session_id: turn.session_id,
        confidence: 0.9,
        reason: 'first version',
      });
      const oldId = writtenId(first);

      // Wait until the OLD row is durably indexed BEFORE the second write. Both the old row's
      // fire-and-forget insert and the supersede's fire-and-forget delete are detached promises;
      // if the insert landed after the delete, the old row would resurrect. Ordering them here
      // makes the prune assertion deterministic (and mutation-detectable).
      await vi.waitFor(() => {
        expect(vecCount('memory_items_vec', 'item_id', oldId)).toBe(1);
      }, WAIT);

      // Different, NON-contradicting properties (no shared scalar key) ⇒ a plain supersede, not a
      // conflict — but the superseded_by back-fill + vec prune fire either way.
      const second = writeMemory({
        type: 'fact',
        content: { label: 'shared memory', properties: { b: 2 } },
        source_turn_id: turn.id,
        source_session_id: turn.session_id,
        confidence: 0.9,
        reason: 'second version',
      });
      const newId = writtenId(second);
      expect(newId).not.toBe(oldId);

      await vi.waitFor(() => {
        expect(vecCount('memory_items_vec', 'item_id', oldId)).toBe(0); // pruned at supersede
        expect(vecCount('memory_items_vec', 'item_id', newId)).toBe(1); // new row indexed
      }, WAIT);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 4 — appendEntity populates entity_vec (AC 6)',
    async () => {
      const entity = appendEntity({
        type: 'Person',
        label: 'Alice',
        properties: {},
        valid_from: new Date().toISOString(),
        valid_until: null,
        confidence: 0.9,
        source: 'test:1',
        superseded_by: null,
        confirmed: false,
      });
      await vi.waitFor(() => {
        expect(vecCount('entity_vec', 'entity_id', entity.id)).toBe(1);
      }, WAIT);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 5 — compactGraph prunes the superseded entity_vec row (AC 6)',
    async () => {
      const survivor = appendEntity({
        type: 'Fact',
        label: 'survivor entity',
        properties: {},
        valid_from: new Date().toISOString(),
        valid_until: null,
        confidence: 0.9,
        source: 'test:survivor',
        superseded_by: null,
        confirmed: false,
      });
      const doomed = appendEntity({
        type: 'Fact',
        label: 'doomed entity',
        properties: {},
        valid_from: new Date().toISOString(),
        valid_until: null,
        confidence: 0.9,
        source: 'test:doomed',
        superseded_by: null,
        confirmed: false,
      });

      // Both must be durably indexed before compaction so the synchronous prune has a row to drop.
      await vi.waitFor(() => {
        expect(vecCount('entity_vec', 'entity_id', survivor.id)).toBe(1);
        expect(vecCount('entity_vec', 'entity_id', doomed.id)).toBe(1);
      }, WAIT);

      appendSupersede(doomed.id, survivor.id); // doomed is now superseded ⇒ dropped on compact
      await compactGraph(graphFile); // vecDelete of non-survivors runs synchronously here

      expect(vecCount('entity_vec', 'entity_id', doomed.id)).toBe(0);
      expect(vecCount('entity_vec', 'entity_id', survivor.id)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 6 — upsertDigest writes one session_digest_vec row, single row on re-digest (AC 5, AC 7)',
    async () => {
      const sid = 'vec-digest-' + Date.now(); // unique ⇒ no collision on the TEXT primary key
      const cid = 'vec-chat-6';
      // Seed a turn directly with the unique session_id (no logTurn ⇒ no stray conversation embed).
      getDb()
        .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?,?,?,?,?)`)
        .run(cid, sid, 'user', 'digest seed turn', new Date().toISOString());

      upsertDigest({
        session_id: sid,
        chat_id: cid,
        summary: 'first summary of the session',
        turn_count: 1,
        entity_draft: null,
        procedural_raw: null,
        parse_error: false,
      });
      await vi.waitFor(() => {
        expect(vecCount('session_digest_vec', 'session_id', sid)).toBe(1);
      }, WAIT);

      // Re-digest the same session: vecReplace (DELETE+INSERT) keeps it at exactly one row (FR 8).
      upsertDigest({
        session_id: sid,
        chat_id: cid,
        summary: 'second, revised summary of the same session',
        turn_count: 1,
        entity_draft: null,
        procedural_raw: null,
        parse_error: false,
      });
      await sleep(800); // let the second replace settle
      expect(vecCount('session_digest_vec', 'session_id', sid)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 7 — EMBED_INLINE=false defers conversation embedding to the digest sweep (AC 13)',
    async () => {
      process.env.EMBED_INLINE = 'false';
      try {
        // Plant a >2h-old anchor turn so logTurn opens a FRESH session containing only t1/t2 —
        // getTurnsForSession is not chat-scoped, so this keeps the sweep scoped to these two turns.
        const oldTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        getDb()
          .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?,?,?,?,?)`)
          .run('vec-chat-7', 'vec7-old-session', 'user', 'old anchor turn', oldTs);

        const t1 = logTurn('vec-chat-7', 'user', 'deferred turn one');
        const t2 = logTurn('vec-chat-7', 'user', 'deferred turn two');
        expect(t1.session_id).toBe(t2.session_id); // both land in the same fresh session

        // Deferred: EMBED_INLINE=false ⇒ logTurn fires no inline embed, so no rows yet.
        await sleep(600);
        expect(vecCount('conversation_vec', 'turn_id', t1.id)).toBe(0);
        expect(vecCount('conversation_vec', 'turn_id', t2.id)).toBe(0);

        // The digest close is the shared sweep choke point: it back-fills every unembedded turn.
        upsertDigest({
          session_id: t1.session_id,
          chat_id: 'vec-chat-7',
          summary: 'a session to sweep',
          turn_count: 2,
          entity_draft: null,
          procedural_raw: null,
          parse_error: false,
        });

        await vi.waitFor(() => {
          expect(vecCount('conversation_vec', 'turn_id', t1.id)).toBe(1);
          expect(vecCount('conversation_vec', 'turn_id', t2.id)).toBe(1);
        }, WAIT);
      } finally {
        delete process.env.EMBED_INLINE;
      }
    },
    TEST_TIMEOUT,
  );
});
