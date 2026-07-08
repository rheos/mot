import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Phase 5 — the eight new Track-2 MCP tools + the FTS `q` arm of memory_recent,
// driven through callMcpTool() directly (NOT the HTTP route).
//
// This file combines BOTH harnesses, like extraction.test.ts:
//   - relational tools (topic_*, procedural_*, memory_recent) hit the SQLite DB via getDb() →
//     set DATABASE_URL to a fresh temp DB and run migrate_db() so all journal + hand-written
//     migrations land (topic_thread, procedural_notes, memory_items_fts).
//   - entity tools (entity_*) read MOT_GRAPH_PATH lazily (lib/graph) → point it at a temp .jsonl.
// Both env vars are set BEFORE the first dynamic import (the lazy-env ordering the data layer
// relies on).
//
// AC-12 is the load-bearing assertion: every new tool dispatch case returns text(errorObject)
// on failure — it NEVER throws. So a documented-error call resolves (not rejects), and the
// returned content parses to a typed { error } object. At the route level that surfaces as a
// successful result with isError:false (the divergence from the Track-1 throw→isError:true
// pattern), which we assert structurally below.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-mcp-tools-'));
const tmpDbPath = path.join(tmpDir, 'mcp-tools.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const { migrate_db, getDb } = await import('../../db/client');
const { callMcpTool } = await import('../../lib/mcp-tools');
const { writeMemory } = await import('../../lib/memory');
const { appendEntity, appendRelate } = await import('../../lib/graph');

// callMcpTool returns ToolContent = [{ type:'text', text: JSON.stringify(data) }]. Parse the
// single text block back into the typed payload the tool produced.
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const content = await callMcpTool(name, args);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

// Seed a conversation turn (so writeMemory's source_turn_id FK + chat_id derivation works).
function seedTurn(chatId: string, sessionId: string, content: string): number {
  const r = getDb()
    .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, 'user', ?, ?)`)
    .run(chatId, sessionId, content, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

// Seed a session_digest row (the FK target for topic_thread_session + procedural_notes).
function seedDigest(sessionId: string, chatId: string, summary: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
       VALUES (?, ?, ?, ?, 3)`,
    )
    .run(sessionId, chatId, summary, new Date().toISOString());
}

beforeAll(() => {
  migrate_db();
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
  delete process.env.MOT_GRAPH_PATH;
});

// ── memory_recent with q (FTS filter, not all active items) ──────────────────

describe('memory_recent with q — FTS-filtered, not all active', () => {
  it('q filters to the matching item; no-q returns both', async () => {
    const turnId = seedTurn('mr-chat', 'mr-sess', 'msg');
    writeMemory({
      type: 'fact',
      content: { label: 'Alex school', properties: { school: 'Greenwood' } },
      source_turn_id: turnId,
      source_session_id: 'mr-sess',
      confidence: 0.9,
      reason: 'stated',
    });
    writeMemory({
      type: 'fact',
      content: { label: 'SampleApp launch', properties: { quarter: 'Q3' } },
      source_turn_id: turnId,
      source_session_id: 'mr-sess',
      confidence: 0.9,
      reason: 'stated',
    });

    // No q → both active items for the chat.
    const allRows = await call('memory_recent', { chat_id: 'mr-chat' });
    expect(Array.isArray(allRows)).toBe(true);
    expect((allRows as unknown[]).length).toBe(2);

    // q='Alex' → only the matching item, not all.
    const filtered = await call('memory_recent', { chat_id: 'mr-chat', q: 'Alex' });
    expect(Array.isArray(filtered)).toBe(true);
    const rows = filtered as { label: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Alex school');
  });

  it('whitespace-only q is ignored (falls back to recent active)', async () => {
    const rows = await call('memory_recent', { chat_id: 'mr-chat', q: '   ' });
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as unknown[]).length).toBe(2); // same as the no-q case above
  });
});

// ── topic_threads / topic_thread_create / topic_thread_link ──────────────────

describe('topic thread tools', () => {
  it('create → list → link happy path', async () => {
    const created = await call('topic_thread_create', { slug: 'alex-school', title: 'Alex school' });
    expect((created as { slug: string }).slug).toBe('alex-school');

    const threads = await call('topic_threads');
    expect(Array.isArray(threads)).toBe(true);
    expect((threads as { slug: string }[]).some((t) => t.slug === 'alex-school')).toBe(true);

    // Link needs a real session_digest row.
    seedDigest('tt-sess-1', 'tt-chat', 'a session');
    const linked = await call('topic_thread_link', { slug: 'alex-school', session_id: 'tt-sess-1' });
    expect((linked as { ok: boolean }).ok).toBe(true);

    // topic_threads with a label returns the thread detail incl. its sessions.
    const detail = await call('topic_threads', { label: 'alex-school' });
    expect((detail as { slug: string }).slug).toBe('alex-school');
    expect((detail as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('topic_threads(label) for a missing slug returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('topic_threads', { label: 'no-such-thread' });
    expect((result as { error: string }).error).toBe('thread_not_found');
  });

  it('topic_thread_create with an existing slug returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('topic_thread_create', { slug: 'alex-school', title: 'dup' });
    expect((result as { error: string }).error).toBe('slug_exists');
  });

  it('topic_thread_create with an invalid slug returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('topic_thread_create', { slug: 'Not A Slug', title: 'x' });
    expect((result as { error: string }).error).toBe('invalid_slug');
  });

  it('topic_thread_link to a missing thread returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('topic_thread_link', { slug: 'ghost-thread', session_id: 'tt-sess-1' });
    expect((result as { error: string }).error).toBe('thread_not_found');
  });
});

// ── entity_get / entity_search / entity_related ──────────────────────────────

describe('entity tools', () => {
  let alexId = '';
  let schoolId = '';

  beforeAll(() => {
    // School is the relation target; Alex child_of → school.
    const school = appendEntity({
      type: 'Project',
      label: 'Greenwood School',
      properties: {},
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: null,
      confidence: 0.9,
      source: 'manual',
      superseded_by: null,
      confirmed: true,
    });
    schoolId = school.id;
    const alex = appendEntity({
      type: 'Person',
      label: 'Alex Goodwin',
      properties: {},
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: null,
      confidence: 0.95,
      source: 'manual',
      superseded_by: null,
      confirmed: true,
    });
    alexId = alex.id;
    // Track 6 — Alex child_of Greenwood via a confirmed relate patch (edges live as patches,
    // not inline on the entity record; the fold rebuilds properties.relations from them).
    appendRelate(alexId, 'child_of', schoolId, 0.95, 'manual', true);
  });

  it('entity_get returns the record plus 1-hop relations (happy path)', async () => {
    const result = await call('entity_get', { id: alexId });
    const r = result as { record: { id: string }; relations: { outbound: { id: string }[] } };
    expect(r.record.id).toBe(alexId);
    expect(r.relations.outbound.map((e) => e.id)).toContain(schoolId);
  });

  it('entity_get on a missing id returns typed { error: entity_not_found }, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('entity_get', { id: 'no-such-entity' });
    expect((result as { error: string }).error).toBe('entity_not_found');
    expect((result as { id: string }).id).toBe('no-such-entity');
  });

  it('entity_search returns matching active entities (happy path)', async () => {
    const result = await call('entity_search', { q: 'Alex' });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { label: string }[]).some((e) => e.label === 'Alex Goodwin')).toBe(true);
  });

  it('entity_search for a non-match returns [] (no throw)', async () => {
    const result = await call('entity_search', { q: 'zzz-no-match' });
    expect(result).toEqual([]);
  });

  it('entity_related traverses from the start entity (happy path)', async () => {
    const result = await call('entity_related', { id: alexId, hops: 1 });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { id: string }[]).map((e) => e.id)).toContain(schoolId);
  });

  it('entity_related from a missing id returns [] (no throw)', async () => {
    const result = await call('entity_related', { id: 'no-such-entity' });
    expect(result).toEqual([]);
  });
});

// ── procedural_notes_list / procedural_note_confirm ──────────────────────────

describe('procedural note tools', () => {
  let pendingId = 0;

  beforeAll(() => {
    seedDigest('pn-sess', 'pn-chat', 'note source session');
    const ins = getDb()
      .prepare(
        `INSERT INTO procedural_notes
           (category, note, note_norm, source_session_id, confirmed, confirmed_at,
            superseded_by, mention_count, chat_id, created_at, ts)
         VALUES ('workflow', 'Taylor prefers bullet replies', 'robin prefers bullet replies',
                 'pn-sess', 0, NULL, NULL, 1, 'pn-chat', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    pendingId = Number(ins.lastInsertRowid);
  });

  it('procedural_notes_list pending=true returns the unconfirmed candidate (happy path)', async () => {
    const result = await call('procedural_notes_list', { pending: true });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { id: number }[]).some((n) => n.id === pendingId)).toBe(true);
  });

  it('procedural_note_confirm confirms a candidate (happy path), then default list groups it by category', async () => {
    const confirmed = await call('procedural_note_confirm', { id: pendingId });
    expect((confirmed as { confirmed: number }).confirmed).toBe(1);

    // Default list (pending=false) groups confirmed notes by category.
    const grouped = await call('procedural_notes_list');
    expect((grouped as Record<string, unknown[]>).workflow).toBeDefined();
    expect((grouped as Record<string, { id: number }[]>).workflow.some((n) => n.id === pendingId)).toBe(true);
  });

  it('procedural_note_confirm on a missing id returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('procedural_note_confirm', { id: 999999 });
    expect((result as { error: string }).error).toBe('not_found');
  });

  it('procedural_note_confirm on an already-confirmed note returns typed error, does not throw (AC-12)', async () => {
    const result = await expectNoThrow('procedural_note_confirm', { id: pendingId });
    expect((result as { error: string }).error).toBe('already_confirmed');
  });
});

// ── Track 6 — edge MCP tools (entity_relate / _confirm / _reject) ────────────

describe('Track 6 edge tools', () => {
  // Fresh entity pair per case (cuid2 ids are unique; the graph file is append-only and shared
  // across this module, so a triple is never reused between assertions).
  function seedTwo(): { from: string; to: string } {
    const mk = (label: string, type: 'Person' | 'Project') =>
      appendEntity({
        type,
        label,
        properties: {},
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_until: null,
        confidence: 0.9,
        source: 'manual',
        superseded_by: null,
        confirmed: true,
      }).id;
    return { from: mk('edge-from', 'Person'), to: mk('edge-to', 'Project') };
  }

  it('entity_relate happy path: writes a confirmed manual edge', async () => {
    const { from, to } = seedTwo();
    const r = (await call('entity_relate', { from, rel: 'child_of', to })) as {
      op: string; from: string; confirmed: boolean; source: string;
    };
    expect(r.op).toBe('relate');
    expect(r.from).toBe(from);
    expect(r.confirmed).toBe(true);
    expect(r.source).toBe('manual');
  });

  it('entity_relate self-relation → { error: self_relate } (AC-5), no throw', async () => {
    const { from } = seedTwo();
    const result = await expectNoThrow('entity_relate', { from, rel: 'child_of', to: from });
    expect((result as { error: string }).error).toBe('self_relate');
  });

  it('entity_relate off-vocabulary verb → { error: invalid_rel }, no throw', async () => {
    const { from, to } = seedTwo();
    const result = await expectNoThrow('entity_relate', { from, rel: 'runs_on', to });
    expect((result as { error: string }).error).toBe('invalid_rel');
  });

  it('entity_relate non-existent from / to → typed errors (AC-5), no throw', async () => {
    const { from, to } = seedTwo();
    const missingFrom = await expectNoThrow('entity_relate', { from: 'no-such', rel: 'child_of', to });
    expect((missingFrom as { error: string }).error).toBe('from_not_found');
    const missingTo = await expectNoThrow('entity_relate', { from, rel: 'child_of', to: 'no-such' });
    expect((missingTo as { error: string }).error).toBe('to_not_found');
  });

  it('entity_relate_confirm happy path + already_confirmed (AC-12), no throw', async () => {
    const { from, to } = seedTwo();
    appendRelate(from, 'child_of', to, 0.8, 'session:s', false); // unconfirmed candidate
    const confirmed = await call('entity_relate_confirm', { from, rel: 'child_of', to });
    expect((confirmed as { confirmed: boolean }).confirmed).toBe(true);
    const again = await expectNoThrow('entity_relate_confirm', { from, rel: 'child_of', to });
    expect((again as { error: string }).error).toBe('already_confirmed');
  });

  it('entity_relate_reject happy path + not_found + already_rejected (AC-12), no throw', async () => {
    const { from, to } = seedTwo();
    appendRelate(from, 'child_of', to, 0.8, 'session:s', false); // live unconfirmed edge
    const rejected = await call('entity_relate_reject', { from, rel: 'child_of', to });
    expect((rejected as { valid_until: string | null }).valid_until).not.toBeNull();
    const notFound = await expectNoThrow('entity_relate_reject', { from, rel: 'child_of', to: 'no-such' });
    expect((notFound as { error: string }).error).toBe('not_found');
    const alreadyRejected = await expectNoThrow('entity_relate_reject', { from, rel: 'child_of', to });
    expect((alreadyRejected as { error: string }).error).toBe('already_rejected');
  });
});

// ── AC-12 confirmation helper ────────────────────────────────────────────────
// Asserts the dispatch case did NOT throw (the call resolves), then parses the result. If a
// case ever re-throws an error object instead of returning text() of it, this rejects and the
// test fails — which is exactly the AC-12 regression we are guarding against. A throw at this
// layer is what would surface as isError:true at the route; returning text() keeps isError:false.

async function expectNoThrow(name: string, args: Record<string, unknown>): Promise<unknown> {
  const content = await callMcpTool(name, args); // must not reject
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}
