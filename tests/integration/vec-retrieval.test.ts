import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Type-only imports are erased at compile time — they do NOT evaluate the module, so they are
// safe before DATABASE_URL is set (unlike the runtime dynamic imports below).
import type { Turn } from '../../lib/conversation';
import type { MemoryRow } from '../../lib/memory';

// ── Track 5 / Phase 2 — vec RETRIEVAL integration tests ─────────────────────────────
// Phase 1 (vec-write.test.ts) proved every write path lands a vec row. This file proves the
// READ side: vector finds turns FTS misses (AC 2), hybrid merges both arms via RRF (AC 3),
// the fts call forms are byte-identical to today (AC 4), the digest vector is REPLACED on
// re-digest (AC 7), the MCP schemas expose `mode` (AC 9), plus the three ratified contracts
// the shipped code carries that AC 1-9 alone don't pin:
//   - normalized-L2 == cosine KNN ordering (fastembed unit-normalizes — a load-bearing
//     invariant for any future embedder swap);
//   - the hybrid-degrade contract (amended 2026-07-06): a degraded VECTOR arm falls back to
//     the FTS-arm result — NOT [] — on all three paths; a vector-ONLY mode degrades to [];
//   - the uniform empty-`q` guard (hybrid → fts-arm behavior, incl. memory recency fallback).
//
// Same opt-in harness as vec-write.test.ts and vec-backfill.test.ts (the three files that
// embed for real):
//   (a) delete MOT_EMBED_DISABLE at module top — env is read lazily per call, so this opts the
//       whole file back in to real embedding; RESTORED to '1' in afterAll.
//   (b) migrate_db() creates all tables incl. the four vec0 tables — getDb() loads the
//       sqlite-vec extension first (db/client.ts), so 0007_vec.sql's CREATE VIRTUAL TABLE runs.
//   (c) skip cleanly (describe.skipIf) when the extension can't load OR the embedder can't init —
//       an extension-missing box and a model-unfetchable box both skip, never partially fail
//       (AC 10). The schema test (AC 9) lives OUTSIDE the skip — listMcpTools() needs neither.

// (a) Opt back in to embedding for this file only.
delete process.env.MOT_EMBED_DISABLE;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-vec-retrieval-'));
const dbPath = path.join(tmpDir, 'vec.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');

// Set env BEFORE any dynamic import that reaches getDb() / graphPath().
process.env.DATABASE_URL = dbPath;
process.env.MOT_GRAPH_PATH = graphFile;

// Dynamic imports AFTER DATABASE_URL is set (getDb reads it lazily, mirroring the other
// integration tests' ordering constraint).
const { migrate_db, getDb } = await import('../../db/client');
const { vecAvailable, vecKnn } = await import('../../lib/vec');
const { embedderAvailable, embed } = await import('../../lib/embedding');
const { logTurn, searchTurns } = await import('../../lib/conversation');
const {
  writeMemory,
  getActiveMemory,
  searchActiveMemory,
  searchActiveMemoryVector,
  searchActiveMemoryHybrid,
} = await import('../../lib/memory');
const { appendEntity, searchEntities } = await import('../../lib/graph');
const { upsertDigest } = await import('../../lib/digest');
const { listMcpTools, callMcpTool } = await import('../../lib/mcp-tools');

// (b) Build the schema. migrate_db() → getDb() loads the vec extension, then runs 0007_vec.sql
// (guarded on vecAvailable()), so all four vec0 tables exist on the SAME connection the app uses.
let appVecOk = false;
try {
  migrate_db();
  appVecOk = vecAvailable();
} catch (err) {
  console.warn('[vec-retrieval.test] migrate/vec setup failed — tests will skip:', (err as Error).message);
}

// (c) Only pay the ~90MB model init when we can actually run — otherwise skip cleanly (AC 10).
const embedderOk = appVecOk ? await embedderAvailable() : false;
const SKIP = !appVecOk || !embedderOk;

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

function vecCount(table: string, idCol: string, id: Id): number {
  const row = getDb().prepare(`SELECT count(*) AS n FROM ${table} WHERE ${idCol} = ?`).get(id) as {
    n: number;
  };
  return row.n;
}

// Read the raw embedding BLOB for one primary-key row (Buffer of dim*4 bytes), or undefined.
function readVecBlob(table: string, idCol: string, id: Id): Buffer | undefined {
  const row = getDb().prepare(`SELECT embedding FROM ${table} WHERE ${idCol} = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  return row?.embedding;
}

function blobToF32(buf: Buffer): Float32Array {
  // Copy out of the (possibly shared) Node Buffer window into a standalone Float32Array.
  return Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// writeMemory returns MemoryRow | { conflict, new } | { error }. Pull the new row id.
function writtenId(res: ReturnType<typeof writeMemory>): number {
  if ('error' in res) throw new Error(`writeMemory error: ${res.error}`);
  return 'conflict' in res ? res.new.id : res.id;
}

// Parse the single text block callMcpTool returns into the typed payload.
async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const content = await callMcpTool(name, args);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text) as T;
}

const WAIT = { timeout: 8_000, interval: 100 };
const TEST_TIMEOUT = 20_000;

// ── AC 9 — the schema pin lives OUTSIDE the skip (no DB, no embedder needed) ───────────
// Also pins `mode` as OPTIONAL (absent from `required`) — its default is enforced in
// dispatch, and the default==fts BEHAVIOR is pinned inside the skip block below.
describe('Track 5 — MCP tool schemas expose mode (AC 9)', () => {
  it('chat_search / memory_recent / entity_search each declare mode enum [fts,vector,hybrid], optional', () => {
    const tools = listMcpTools();
    for (const name of ['chat_search', 'memory_recent', 'entity_search']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} tool must exist`).toBeDefined();
      const schema = tool!.inputSchema as {
        properties: Record<string, { type?: string; enum?: string[] }>;
        required?: string[];
      };
      const mode = schema.properties.mode;
      expect(mode, `${name}.mode property must exist`).toBeDefined();
      expect(mode.type).toBe('string');
      // Exact enum + order — the three modes, nothing else.
      expect(mode.enum).toEqual(['fts', 'vector', 'hybrid']);
      // mode is optional: omitting it is legal and falls back to the fts default.
      expect(schema.required ?? []).not.toContain('mode');
    }
  });
});

describe.skipIf(SKIP)('Track 5 — vec retrieval', () => {
  // Shared memory + entity fixtures used by the default-fts, recency-fallback, and degrade
  // tests. Awaited so their vec rows are durable before any vector/degrade test reads them.
  let memChat: string;
  let memItemId: number;
  let entityId: string;

  beforeAll(async () => {
    memChat = 'ret-mem';
    const t = logTurn(memChat, 'user', 'anchor turn to hang the memory fixture on');
    memItemId = writtenId(
      writeMemory({
        type: 'fact',
        content: { label: 'server backup schedule', properties: {} },
        source_turn_id: t.id,
        source_session_id: t.session_id,
        confidence: 0.9,
        reason: 'nightly ops note',
      }),
    );
    const e = appendEntity({
      type: 'Project',
      label: 'Orchard Deployment Pipeline',
      properties: {},
      valid_from: new Date().toISOString(),
      valid_until: null,
      confidence: 0.9,
      source: 'test:fixture',
      superseded_by: null,
      confirmed: false,
    });
    entityId = e.id;

    await vi.waitFor(() => {
      expect(vecCount('memory_items_vec', 'item_id', memItemId)).toBe(1);
      expect(vecCount('entity_vec', 'entity_id', entityId)).toBe(1);
    }, WAIT);
  }, TEST_TIMEOUT);

  it(
    'TEST 1 — vector finds a turn FTS misses (AC 2)',
    async () => {
      // Zero lexical overlap between query and stored turn after porter stemming.
      const turn = logTurn('ret-chat-1', 'user', "Alex's homework from Lincoln Elementary was due Monday.");
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', turn.id)).toBe(1);
      }, WAIT);

      const q = 'school assignment deadline';
      // FTS: the porter stemmer won't match school/assign/deadlin against homework/Lincoln.
      const ftsHits = searchTurns(q, undefined, 10);
      expect(ftsHits.some((r) => r.id === turn.id)).toBe(false);
      expect(ftsHits).toHaveLength(0);

      // Vector: the semantic hit surfaces despite zero shared stems (the "Lincoln Elementary /
      // school thing" criterion — AC 2 / the spec's headline outcome).
      const vecHits = await searchTurns(q, undefined, 10, 'vector');
      expect(vecHits.some((r) => r.id === turn.id)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 2 — hybrid merges fts + vector via RRF, de-duped (AC 3)',
    async () => {
      // ftsHit: matches the phrase "car repair" lexically. vecHit: same topic, zero shared stems.
      const ftsHit = logTurn('ret-chat-2', 'user', 'The car repair manual is on the shelf.');
      const vecHit = logTurn('ret-chat-2', 'user', 'My automobile needs its engine fixed by a mechanic.');
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', ftsHit.id)).toBe(1);
        expect(vecCount('conversation_vec', 'turn_id', vecHit.id)).toBe(1);
      }, WAIT);

      const q = 'car repair';
      // fts arm alone finds ftsHit (adjacent phrase) but NOT vecHit (no car/repair stems).
      const ftsOnly = searchTurns(q, undefined, 10);
      expect(ftsOnly.some((r) => r.id === ftsHit.id)).toBe(true);
      expect(ftsOnly.some((r) => r.id === vecHit.id)).toBe(false);

      const hybrid = await searchTurns(q, undefined, 10, 'hybrid');
      // At least one hit from each path: the lexical-only ftsHit AND the semantic-only vecHit.
      expect(hybrid.some((r) => r.id === ftsHit.id)).toBe(true);
      expect(hybrid.some((r) => r.id === vecHit.id)).toBe(true);
      // No duplicate turn ids after the RRF merge.
      const ids = hybrid.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 3 — fts parity: every fts call form returns the same result (AC 4)',
    async () => {
      // OVERRIDE (noted in handoff): the prompt's literal `searchTurns(q, undefined, 10, "fts")`
      // does NOT typecheck against the shipped overloads — the 4-arg overload accepts only
      // 'vector'|'hybrid' (mode:'fts' IS the ≤3-arg sync form, and the chat_search dispatch
      // routes both no-mode and mode:'fts' to searchTurns(q, chatId, limit)). So the third fts
      // call form is exercised through the MCP dispatch, which is where a real 'fts' string lands.
      const turn = logTurn('ret-chat-3', 'user', 'pomegranate export licence paperwork');
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', turn.id)).toBe(1);
      }, WAIT);

      const q = 'pomegranate';
      const r1 = searchTurns(q); // 1-arg
      const r2 = searchTurns(q, undefined, 10); // 3-arg
      expect(r2).toEqual(r1);
      expect(r1.some((r) => r.id === turn.id)).toBe(true);

      // Third form: mode:'fts' via the dispatch === no-mode (default) === direct sync call.
      const viaDefault = await call<Turn[]>('chat_search', { q });
      const viaFts = await call<Turn[]>('chat_search', { q, mode: 'fts' });
      expect(viaFts).toEqual(viaDefault);
      expect(viaDefault).toEqual(r1);
    },
    TEST_TIMEOUT,
  );

  it('TEST 3b — default mode is fts for all three tools (behavioral pin)', async () => {
    // No-mode === explicit mode:'fts' on every tool → fts is the effective default (the
    // schema carries no JSON `default` key; the default is enforced in dispatch).
    const chatDefault = await call('chat_search', { q: 'pomegranate' });
    const chatFts = await call('chat_search', { q: 'pomegranate', mode: 'fts' });
    expect(chatFts).toEqual(chatDefault);

    const memDefault = await call('memory_recent', { chat_id: memChat });
    const memFts = await call('memory_recent', { chat_id: memChat, mode: 'fts' });
    expect(memFts).toEqual(memDefault);

    const entDefault = await call('entity_search', { q: 'orchard' });
    const entFts = await call('entity_search', { q: 'orchard', mode: 'fts' });
    expect(entFts).toEqual(entDefault);
  });

  it(
    'TEST 4 — upsertDigest REPLACES the session vector on re-digest (AC 7)',
    async () => {
      const sid = 'ret-digest-' + Date.now();
      const summaryA = 'The plumbing repair under the kitchen sink is scheduled for Tuesday.';
      const summaryB = 'Alex scored the winning goal at the soccer championship final.';

      upsertDigest({
        session_id: sid,
        chat_id: 'ret-chat-4',
        summary: summaryA,
        turn_count: 1,
        entity_draft: null,
        procedural_raw: null,
        parse_error: false,
      });
      await vi.waitFor(() => {
        expect(vecCount('session_digest_vec', 'session_id', sid)).toBe(1);
      }, WAIT);
      const blobA = readVecBlob('session_digest_vec', 'session_id', sid);
      expect(blobA).toBeDefined();

      // Re-digest with a semantically UNRELATED summary.
      upsertDigest({
        session_id: sid,
        chat_id: 'ret-chat-4',
        summary: summaryB,
        turn_count: 1,
        entity_draft: null,
        procedural_raw: null,
        parse_error: false,
      });
      // The replace (vecReplace = DELETE+INSERT) is fire-and-forget; poll until the blob changes.
      await vi.waitFor(() => {
        const cur = readVecBlob('session_digest_vec', 'session_id', sid);
        expect(cur).toBeDefined();
        expect(cur!.equals(blobA!)).toBe(false); // bytes actually changed — the vector was REPLACED
      }, WAIT);

      // Still exactly one row (PK-enforced), and its content is summary B, not summary A.
      expect(vecCount('session_digest_vec', 'session_id', sid)).toBe(1);
      const stored = blobToF32(readVecBlob('session_digest_vec', 'session_id', sid)!);
      const vA = await embed(summaryA);
      const vB = await embed(summaryB);
      expect(l2(stored, vB)).toBeLessThan(l2(stored, vA)); // stored is closer to B than A
      expect(l2(stored, vB)).toBeLessThan(1e-3); // stored ≈ B's embedding (a genuine replace)
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 5 — normalized-L2 == cosine KNN ordering: nearest is the semantically closest (invariant)',
    async () => {
      // fastembed unit-normalizes MiniLM output, so L2-distance KNN ranks identically to cosine.
      // Three turns at clearly different semantic distance from the query prove the ranking holds.
      // Seeded in REVERSE of the expected ranking (far, mid, near) so insertion order AND id
      // order both disagree with semantic order — a "rows in insertion/id order instead of KNN
      // distance order" regression (e.g. dropping the post-IN re-sort) cannot stay green.
      const far = logTurn('ret-l2', 'user', 'She published a gentle poem about autumn leaves drifting down.');
      const mid = logTurn('ret-l2', 'user', 'The mechanic gave me a written quote for new brake pads.');
      const near = logTurn('ret-l2', 'user', 'I fixed the automobile motor problem in my garage yesterday.');
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', near.id)).toBe(1);
        expect(vecCount('conversation_vec', 'turn_id', mid.id)).toBe(1);
        expect(vecCount('conversation_vec', 'turn_id', far.id)).toBe(1);
      }, WAIT);

      const results = await searchTurns('repairing the car engine in the garage', 'ret-l2', 10, 'vector');
      const order = results.map((r) => r.id);
      // Nearest by semantics is ranked first; the unrelated turn ranks after the near one.
      expect(order[0]).toBe(near.id);
      expect(order.indexOf(near.id)).toBeLessThan(order.indexOf(far.id));
      expect(order.indexOf(near.id)).toBeLessThan(order.indexOf(mid.id));
    },
    TEST_TIMEOUT,
  );

  it('TEST 6 — memory_recent hybrid with empty q falls back to recency (getActiveMemory)', async () => {
    // Uniform empty-q guard: the vector arm short-circuits to [] (no embed call), so hybrid
    // returns exactly the fts-arm result — for empty q that is getActiveMemory (recency order).
    const expected = getActiveMemory(memChat, 20).map((m) => m.id);
    expect(expected).toContain(memItemId);

    const hybrid = await call<MemoryRow[]>('memory_recent', { chat_id: memChat, mode: 'hybrid' });
    expect(hybrid.map((m) => m.id)).toEqual(expected);

    // And it equals the plain no-mode recency response — hybrid empty-q === default empty-q.
    const recency = await call<MemoryRow[]>('memory_recent', { chat_id: memChat });
    expect(hybrid.map((m) => m.id)).toEqual(recency.map((m) => m.id));
  });

  // ── Degrade group (LAST — each drops then recreates its vec0 table) ──────────────────
  // OVERRIDE (noted in handoff): the ratified 2026-07-06 spec amendment wins over the prompt's
  // era. On every path: a degraded VECTOR arm inside HYBRID falls back to the FTS-arm result
  // (NOT []); a vector-ONLY mode degrades to []. embed-off would silently skip the vector arm
  // and never exercise degrade, so we force a REAL throw by DROPping the vec0 table (vecKnn then
  // throws "no such table", caught by the arm's guard).

  it(
    'TEST 7 — conversation: hybrid vector-arm degrade → FTS rows, vector-only → [] ',
    async () => {
      const hit = logTurn('ret-deg-conv', 'user', 'strawberry inventory reconciliation notes');
      await vi.waitFor(() => {
        expect(vecCount('conversation_vec', 'turn_id', hit.id)).toBe(1);
      }, WAIT);

      const q = 'strawberry';
      getDb().exec('DROP TABLE conversation_vec'); // force a real throw in the vector arm
      try {
        // vector-only mode degrades to [] (obligation e).
        const vectorOnly = await searchTurns(q, undefined, 10, 'vector');
        expect(vectorOnly).toEqual([]);

        // hybrid falls back to the FTS-arm rows — NOT [] (obligation d / amended spec).
        const hybrid = await searchTurns(q, undefined, 10, 'hybrid');
        expect(hybrid.length).toBeGreaterThan(0);
        expect(hybrid.some((r) => r.id === hit.id)).toBe(true);
      } finally {
        getDb().exec(
          'CREATE VIRTUAL TABLE IF NOT EXISTS conversation_vec USING vec0(turn_id INTEGER PRIMARY KEY, embedding FLOAT[384])',
        );
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 8 — memory: hybrid vector-arm degrade → FTS rows, vector-only → []',
    async () => {
      // The fixture item ('server backup schedule') is FTS-matchable on "backup".
      const q = 'backup';
      expect(searchActiveMemory(q, memChat, 10).some((m) => m.id === memItemId)).toBe(true);

      getDb().exec('DROP TABLE memory_items_vec');
      try {
        const vectorOnly = await searchActiveMemoryVector(q, memChat, 10);
        expect(vectorOnly).toEqual([]);

        const hybrid = await searchActiveMemoryHybrid(q, memChat, 10);
        expect(hybrid.length).toBeGreaterThan(0);
        expect(hybrid.some((m) => m.id === memItemId)).toBe(true);
      } finally {
        getDb().exec(
          'CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec USING vec0(item_id INTEGER PRIMARY KEY, embedding FLOAT[384])',
        );
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'TEST 9 — entity: hybrid vector-arm degrade → FTS rows, vector-only → []',
    async () => {
      // The fixture entity ('Orchard Deployment Pipeline') is substring-matchable on "orchard".
      const q = 'orchard';
      expect(searchEntities(q).some((e) => e.id === entityId)).toBe(true);

      getDb().exec('DROP TABLE entity_vec');
      try {
        const vectorOnly = await searchEntities(q, undefined, undefined, 'vector');
        expect(vectorOnly).toEqual([]);

        const hybrid = await searchEntities(q, undefined, undefined, 'hybrid');
        expect(hybrid.length).toBeGreaterThan(0);
        expect(hybrid.some((e) => e.id === entityId)).toBe(true);
      } finally {
        getDb().exec(
          'CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(entity_id TEXT PRIMARY KEY, embedding FLOAT[384])',
        );
      }
    },
    TEST_TIMEOUT,
  );
});
