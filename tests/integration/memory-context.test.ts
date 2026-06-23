import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Track 4 — memoryContext, the one-call session boot bundle (FR-1, AC-1/2, EC-5).
//
// Harness mirrors procedural.test.ts: a real temp DB driven through migrate_db() (which applies
// the full hand-written stack — topic_threads, procedural_notes, both FTS files) PLUS a temp
// graph file via MOT_GRAPH_PATH (the lazy-env pattern from graph.test.ts). Both env vars are set
// before the first dynamic import so the singleton DB handle and the lazy graph path resolve to
// the temp locations. The async-overlap timing proof (AC-3) lives in memory-context-timing.test.ts
// because it vi.mock()s the four branch functions and those mocks must not leak into this file.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-mem-ctx-'));
const dbPath = path.join(tmpDir, 'memory-context.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');

process.env.DATABASE_URL = dbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const { migrate_db, getDb } = await import('../../db/client');
const { memoryContext } = await import('../../lib/memory-context');
const { appendEntity } = await import('../../lib/graph');
const { writeMemory } = await import('../../lib/memory');
const { insertCandidate, confirmNote, listNotes } = await import('../../lib/procedural');
const { createThread } = await import('../../lib/topics');

const CHAT_ID = 'ctx-chat';
const SESSION_ID = 'ctx-sess';

// Insert a conversation turn (writeMemory needs the FK + derives chat_id from it) and return its id.
function seedTurn(content: string, ts: string): number {
  const r = getDb()
    .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(CHAT_ID, SESSION_ID, 'user', content, ts);
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  migrate_db();

  // A session_digest row is the FK target for procedural notes (source_session_id) and for any
  // topic-thread session links we might add later.
  getDb()
    .prepare(
      `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
       VALUES (?, ?, 'Ctx session', '2026-06-01T10:00:00.000Z', 1)`,
    )
    .run(SESSION_ID, CHAT_ID);

  // ── Seed all four stores. ──

  // Topics: two threads, one mentioning "school" so the q-filter has something to match.
  createThread('alex-school', 'Alex school logistics', 'pickup times and the school calendar');
  createThread('sampleapp-billing', 'SampleApp billing', 'invoices and renewals');

  // Entities: one carrying "alex", one unrelated. searchEntities('') returns active only.
  appendEntity({
    type: 'Person',
    label: 'Alex',
    properties: { note: 'attends school' },
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.95,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
  });
  appendEntity({
    type: 'Project',
    label: 'SampleApp',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
  });

  // Procedural: insert two candidates, confirm them (memoryContext returns CONFIRMED notes only).
  const a = insertCandidate('school', 'Pick Alex up from school at 3pm', SESSION_ID, CHAT_ID);
  const b = insertCandidate('workflow', 'Run typecheck before every commit', SESSION_ID, CHAT_ID);
  confirmNote((a as { id: number }).id);
  confirmNote((b as { id: number }).id);

  // Memory: one row mentioning "school"/"alex", one unrelated. writeMemory needs a turn FK.
  const t1 = seedTurn('about school', '2026-06-02T10:00:00.000Z');
  writeMemory({
    type: 'fact',
    content: { label: 'Alex school start', properties: { detail: 'school starts in September' } },
    source_turn_id: t1,
    source_session_id: SESSION_ID,
    confidence: 0.9,
    reason: 'stated',
  });
  const t2 = seedTurn('about coffee', '2026-06-02T11:00:00.000Z');
  writeMemory({
    type: 'preference',
    content: { label: 'Coffee', properties: { order: 'flat white' } },
    source_turn_id: t2,
    source_session_id: SESSION_ID,
    confidence: 0.9,
    reason: 'stated',
  });
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// ── AC-1: no-args boot bundle ─────────────────────────────────────────────────

describe('memoryContext — no-args boot bundle (AC-1)', () => {
  it('returns all four array keys, populated, without throwing', async () => {
    const ctx = await memoryContext();
    expect(Array.isArray(ctx.topics)).toBe(true);
    expect(Array.isArray(ctx.entities)).toBe(true);
    expect(Array.isArray(ctx.procedural)).toBe(true);
    expect(Array.isArray(ctx.recent_memory)).toBe(true);
    // All four stores were seeded, so the recency path returns at least one of each.
    expect(ctx.topics.length).toBeGreaterThan(0);
    expect(ctx.entities.length).toBeGreaterThan(0);
    expect(ctx.procedural.length).toBeGreaterThan(0);
    expect(ctx.recent_memory.length).toBeGreaterThan(0);
  });

  it('completes in ≤200ms on a ≤1000-record dataset', async () => {
    const start = performance.now();
    await memoryContext();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThanOrEqual(200);
  });

  it('procedural section is a flat ProceduralNote[], NOT the grouped Record', async () => {
    const ctx = await memoryContext();
    // A flat array of notes, each with a .note string — proves Object.values(grouped).flat().
    expect(Array.isArray(ctx.procedural)).toBe(true);
    for (const note of ctx.procedural) {
      expect(typeof note.note).toBe('string');
      expect(typeof note.id).toBe('number');
    }
    // Cross-check the count against the source grouped shape, flattened the same way.
    const grouped = listNotes(undefined, false) as Record<string, ProceduralNoteLike[]>;
    const flatCount = Object.values(grouped).flat().length;
    expect(ctx.procedural.length).toBe(flatCount);
  });
});

// A structural alias for the cross-check above (avoids importing the full type just for a length).
type ProceduralNoteLike = { id: number; note: string };

// ── AC-2: relevance filtering on a real query ─────────────────────────────────

describe('memoryContext — relevance filtering (AC-2)', () => {
  it('q="alex school" surfaces a matching result in a non-empty section', async () => {
    const ctx = await memoryContext('alex school');

    const containsTerm = (s: string) =>
      s.toLowerCase().includes('alex') || s.toLowerCase().includes('school');

    const hit =
      ctx.topics.some((t) => containsTerm(`${t.title} ${t.slug} ${t.notes ?? ''}`)) ||
      ctx.entities.some((e) => containsTerm(e.label + ' ' + JSON.stringify(e.properties))) ||
      ctx.procedural.some((n) => containsTerm(n.note)) ||
      ctx.recent_memory.some((m) => containsTerm(m.label + ' ' + m.properties));

    expect(hit).toBe(true);
  });
});

// ── EC-5: empty / absent q never errors, always arrays ────────────────────────

describe('memoryContext — empty/absent q (EC-5, FR-1.5/1.7)', () => {
  it('no-args and q="" both return all four keys as arrays, no throw', async () => {
    const a = await memoryContext();
    const b = await memoryContext('');

    for (const ctx of [a, b]) {
      expect(Array.isArray(ctx.topics)).toBe(true);
      expect(Array.isArray(ctx.entities)).toBe(true);
      expect(Array.isArray(ctx.procedural)).toBe(true);
      expect(Array.isArray(ctx.recent_memory)).toBe(true);
    }

    // An empty q must route recent_memory to getActiveMemory (recency), NOT searchActiveMemory('')
    // which short-circuits to []. Both empty-q paths therefore see the seeded recency rows.
    expect(a.recent_memory.length).toBeGreaterThan(0);
    expect(b.recent_memory.length).toBeGreaterThan(0);
  });

  it('whitespace-only q routes recent_memory to the recency path (not searchActiveMemory)', async () => {
    const ctx = await memoryContext('   ');
    expect(Array.isArray(ctx.recent_memory)).toBe(true);
    // Whitespace q trims to empty → getActiveMemory → seeded rows present.
    expect(ctx.recent_memory.length).toBeGreaterThan(0);
  });
});
