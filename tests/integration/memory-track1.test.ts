import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration tests for Track 1 session memory (Prompts 1–3).
// Covers all load-bearing acceptance criteria (AC-1 through AC-15, EC-10).
// Setup mirrors conversation.test.ts: real temp DB, drizzle migrator + hand-written FTS files,
// WAL + foreign keys on. DATABASE_URL and MOT_API_KEY set at module top level before any import.

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-mem-track1-'));
const dbPath = path.join(tmpDir, 'memory-track1.db');

// Must be set before any dynamic import that calls getDb() or reads MOT_API_KEY.
process.env.DATABASE_URL = dbPath;
process.env.MOT_API_KEY = 'mem-track1-test-key-01234';

// Apply all journal migrations (0000_init, 0002_ui_credentials, 0003_conversation,
// 0003_complex_roxanne_simpson) plus the two hand-written FTS files.
const seed = new Database(dbPath);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
migrate(drizzle(seed), { migrationsFolder });
seed.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
seed.exec(fs.readFileSync(path.join(migrationsFolder, '0003_conversation_fts.sql'), 'utf8'));
// Track 6 — adds session_digest.relation_draft, which upsertDigest now writes to.
seed.exec(fs.readFileSync(path.join(migrationsFolder, '0008_relation_draft.sql'), 'utf8'));
seed.close();

// Bootstrap the API key so route tests can authenticate.
const { bootstrapApiKey } = await import('../../lib/auth');
await bootstrapApiKey();

// Data-layer modules — dynamic import so DATABASE_URL is set before singleton initialises.
const { upsertDigest, getDigests, structuralDigest } = await import('../../lib/digest');
const { writeMemory, getActiveMemory } = await import('../../lib/memory');
const { logTurn, getTurnsForSession } = await import('../../lib/conversation');
const { listMcpTools, callMcpTool } = await import('../../lib/mcp-tools');

// Route modules.
const digestRoute  = await import('../../app/api/conversation/digest/route');
const digestsRoute = await import('../../app/api/conversation/digests/route');
const memoryRoute  = await import('../../app/api/memory/route');
const convRoute    = await import('../../app/api/conversation/route');

// Second DB connection for direct seeding (explicit timestamps, controlled session_ids).
const directDb = new Database(dbPath);

const API_KEY = 'mem-track1-test-key-01234';
const H = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

afterAll(() => {
  directDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedTurn(
  chatId: string,
  sessionId: string,
  role: 'user' | 'rheo',
  content: string,
  ts: string,
): number {
  const r = directDb
    .prepare(`INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(chatId, sessionId, role, content, ts);
  return Number(r.lastInsertRowid);
}

function nowTs(): string {
  return new Date().toISOString();
}

// ── AC-1: Digest upsert ───────────────────────────────────────────────────────

describe('digest upsert (AC-1, FR-4)', () => {
  it('inserts a digest row with expected non-null fields', () => {
    const row = upsertDigest({
      session_id: 'ac1-session-a',
      chat_id: 'ac1-chat',
      summary: 'First summary.',
      turn_count: 3,
    });
    expect(row.session_id).toBe('ac1-session-a');
    expect(row.summary).toBe('First summary.');
    expect(row.ts).toBeTruthy();
    expect(row.turn_count).toBe(3);
  });

  it('upserts the same session_id — one row, updated summary (ON CONFLICT)', () => {
    upsertDigest({
      session_id: 'ac1-session-b',
      chat_id: 'ac1-chat',
      summary: 'Original summary.',
      turn_count: 2,
    });
    upsertDigest({
      session_id: 'ac1-session-b',
      chat_id: 'ac1-chat',
      summary: 'Updated summary.',
      turn_count: 4,
    });

    const rows = directDb
      .prepare(`SELECT * FROM session_digest WHERE session_id = ?`)
      .all('ac1-session-b') as { summary: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('Updated summary.');
  });
});

// ── AC-2: POST /api/conversation/digest route ─────────────────────────────────

describe('POST /api/conversation/digest (AC-2)', () => {
  function makePost(body: unknown): Request {
    return new Request('http://localhost/api/conversation/digest', {
      method: 'POST',
      headers: H,
      body: JSON.stringify(body),
    });
  }

  it('valid body → 200 + row with session_id', async () => {
    const res = await digestRoute.POST(makePost({
      session_id: 'ac2-session-ok',
      summary: 'A valid summary.',
      chat_id: 'ac2-chat',
      turn_count: 5,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { session_id: string };
    expect(body.session_id).toBe('ac2-session-ok');
  });

  it('missing summary → 422 (non-500)', async () => {
    const res = await digestRoute.POST(makePost({
      session_id: 'ac2-session-no-summary',
      chat_id: 'ac2-chat',
      turn_count: 2,
    }));
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('missing session_id → 422 (non-500)', async () => {
    const res = await digestRoute.POST(makePost({
      summary: 'A summary.',
      chat_id: 'ac2-chat',
      turn_count: 2,
    }));
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ── AC-3: GET /api/conversation/digests route ─────────────────────────────────

describe('GET /api/conversation/digests (AC-3)', () => {
  it('returns ≤ n digests ordered ts desc', async () => {
    upsertDigest({ session_id: 'ac3-sess-1', chat_id: 'ac3-chat', summary: 'S1', turn_count: 1 });
    upsertDigest({ session_id: 'ac3-sess-2', chat_id: 'ac3-chat', summary: 'S2', turn_count: 2 });

    const res = await digestsRoute.GET(
      new Request('http://localhost/api/conversation/digests?chat_id=ac3-chat&n=5', { headers: H }),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as { session_id: string; ts: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    // Ordered ts desc: first ts >= last ts.
    if (rows.length >= 2) {
      expect(rows[0].ts >= rows[rows.length - 1].ts).toBe(true);
    }
  });

  it('unknown chat_id → [] with status 200 (not 500)', async () => {
    const res = await digestsRoute.GET(
      new Request('http://localhost/api/conversation/digests?chat_id=ac3-unknown', { headers: H }),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as unknown[];
    expect(rows).toEqual([]);
  });
});

// ── AC-4: Full receipt on memory_items row ────────────────────────────────────

describe('full receipt on memory_items row (AC-4)', () => {
  it('writeMemory returns a row with all required fields non-null', () => {
    const turnId = seedTurn('ac4-chat', 'ac4-sess', 'user', 'hello', nowTs());
    const result = writeMemory({
      type: 'fact',
      content: { label: 'AC4 test label', properties: { value: 'x' } },
      source_turn_id: turnId,
      source_session_id: 'ac4-sess',
      confidence: 0.9,
      reason: 'stated explicitly',
    });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      const row = 'conflict' in result ? result.new : result;
      expect(row.source_turn_id).toBe(turnId);
      expect(row.source_session_id).toBe('ac4-sess');
      expect(row.confidence).toBe(0.9);
      expect(row.ts).toBeTruthy();
      expect(row.reason).toBe('stated explicitly');
    }
  });
});

// ── AC-5: Bad source_turn_id ──────────────────────────────────────────────────

describe('bad source_turn_id (AC-5)', () => {
  it('non-existent source_turn_id → error, no row inserted', () => {
    const result = writeMemory({
      type: 'fact',
      content: { label: 'AC5 phantom', properties: {} },
      source_turn_id: 99999,
      source_session_id: 'ac5-sess',
      confidence: 0.8,
      reason: 'test',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('source_turn_id not found');
    }
    const count = (directDb.prepare(
      `SELECT COUNT(*) as n FROM memory_items WHERE source_turn_id = 99999`
    ).get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

// ── AC-6: Factual conflict ────────────────────────────────────────────────────

describe('factual conflict detection (AC-6)', () => {
  it('two high-confidence contradictory writes → conflict_flag=true, superseded_by set, result.conflict=true', () => {
    const turnId = seedTurn('ac6-chat', 'ac6-sess', 'user', 'msg', nowTs());

    const r1 = writeMemory({
      type: 'fact',
      content: { label: 'home city', properties: { city: 'Vancouver' } },
      source_turn_id: turnId,
      source_session_id: 'ac6-sess',
      confidence: 0.9,
      reason: 'stated',
    });
    expect('error' in r1).toBe(false);
    const first = ('conflict' in r1 ? r1.new : r1) as { id: number };

    const r2 = writeMemory({
      type: 'fact',
      content: { label: 'home city', properties: { city: 'Calgary' } },
      source_turn_id: turnId,
      source_session_id: 'ac6-sess',
      confidence: 0.9,
      reason: 'correction',
    });

    expect('conflict' in r2).toBe(true);
    if ('conflict' in r2) {
      expect(r2.new.conflict_flag).toBe(1);
      expect(r2.superseded.id).toBe(first.id);
    }

    const oldRow = directDb
      .prepare(`SELECT superseded_by FROM memory_items WHERE id = ?`)
      .get(first.id) as { superseded_by: number | null };
    expect(oldRow.superseded_by).not.toBeNull();
  });
});

// ── AC-7: Non-conflicting update ──────────────────────────────────────────────

describe('non-conflicting update (AC-7)', () => {
  it('low-confidence update → two rows, both conflict_flag=0, old superseded, old properties unchanged', () => {
    const turnId = seedTurn('ac7-chat', 'ac7-sess', 'user', 'msg', nowTs());

    const r1 = writeMemory({
      type: 'preference',
      content: { label: 'reply style', properties: { tone: 'concise' } },
      source_turn_id: turnId,
      source_session_id: 'ac7-sess',
      confidence: 0.9,
      reason: 'stated preference',
    });
    const first = 'error' in r1 || 'conflict' in r1 ? null : r1;
    expect(first).not.toBeNull();

    const r2 = writeMemory({
      type: 'preference',
      content: { label: 'reply style', properties: { tone: 'brief', detail: 'on-request' } },
      source_turn_id: turnId,
      source_session_id: 'ac7-sess',
      confidence: 0.6, // below 0.8 threshold — cannot be a conflict
      reason: 'refined',
    });
    expect('conflict' in r2).toBe(false);
    expect('error' in r2).toBe(false);

    // Both rows exist with conflict_flag=0.
    const rows = directDb
      .prepare(`SELECT * FROM memory_items WHERE type = 'preference' AND label_norm = 'reply style' AND chat_id = 'ac7-chat'`)
      .all() as { conflict_flag: number; properties: string; superseded_by: number | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.conflict_flag === 0)).toBe(true);

    // Old row has superseded_by set; its properties are unchanged (append-only).
    const oldRow = rows.find((r) => r.superseded_by !== null);
    expect(oldRow).toBeDefined();
    const oldProps = JSON.parse(oldRow!.properties) as { tone: string };
    expect(oldProps.tone).toBe('concise'); // original value, not mutated
  });
});

// ── AC-13: Append-only minor wording ─────────────────────────────────────────

describe('append-only versioning (AC-13)', () => {
  it('same label + equivalent properties → two rows, conflict_flag=0, no in-place mutation', () => {
    const turnId = seedTurn('ac13-chat', 'ac13-sess', 'user', 'msg', nowTs());
    const props = { fruit: 'apple' };

    writeMemory({
      type: 'fact',
      content: { label: 'favourite fruit', properties: props },
      source_turn_id: turnId,
      source_session_id: 'ac13-sess',
      confidence: 0.9,
      reason: 'stated',
    });
    writeMemory({
      type: 'fact',
      content: { label: 'favourite fruit', properties: props },
      source_turn_id: turnId,
      source_session_id: 'ac13-sess',
      confidence: 0.9,
      reason: 'confirmed again',
    });

    const rows = directDb
      .prepare(`SELECT * FROM memory_items WHERE chat_id = 'ac13-chat' AND label_norm = 'favourite fruit'`)
      .all() as { conflict_flag: number; superseded_by: number | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.conflict_flag === 0)).toBe(true);
    expect(rows.filter((r) => r.superseded_by !== null)).toHaveLength(1);
  });
});

// ── AC-8: summarize_and_archive on zero-turn session ─────────────────────────

describe('summarize_and_archive zero-turn session (AC-8)', () => {
  it('structuralDigest on unknown session_id → error object, no row in session_digest', () => {
    const result = structuralDigest('no-such-session-id');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('no turns found for session');
      expect(result.session_id).toBe('no-such-session-id');
    }

    const row = directDb
      .prepare(`SELECT id FROM session_digest WHERE session_id = 'no-such-session-id'`)
      .get();
    expect(row).toBeUndefined();
  });
});

// ── AC-12: Confidence outside 0–1 ────────────────────────────────────────────

describe('confidence out of range (AC-12)', () => {
  it('confidence: 1.5 → typed error, no row inserted', () => {
    const turnId = seedTurn('ac12-chat', 'ac12-sess', 'user', 'msg', nowTs());
    const result = writeMemory({
      type: 'fact',
      content: { label: 'AC12 over', properties: {} },
      source_turn_id: turnId,
      source_session_id: 'ac12-sess',
      confidence: 1.5,
      reason: 'test',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('confidence must be between 0 and 1');
    }
    const count = (directDb.prepare(
      `SELECT COUNT(*) as n FROM memory_items WHERE chat_id = 'ac12-chat' AND label_norm = 'ac12 over'`
    ).get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('confidence: -0.1 → typed error, no row inserted', () => {
    const turnId = seedTurn('ac12-chat-neg', 'ac12-sess-neg', 'user', 'msg', nowTs());
    const result = writeMemory({
      type: 'fact',
      content: { label: 'AC12 under', properties: {} },
      source_turn_id: turnId,
      source_session_id: 'ac12-sess-neg',
      confidence: -0.1,
      reason: 'test',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('confidence must be between 0 and 1');
    }
  });
});

// ── chat_id derived from source_turn_id ──────────────────────────────────────

describe('chat_id server-derived from source_turn_id (FR-8, FR-10)', () => {
  it('stored row.chat_id matches the conversation row, not any caller-supplied value', () => {
    const turnId = seedTurn('derived-chat-123', 'derived-sess', 'user', 'msg', nowTs());
    const result = writeMemory({
      type: 'fact',
      content: { label: 'server derived chat id', properties: { x: 1 } },
      source_turn_id: turnId,
      source_session_id: 'derived-sess',
      confidence: 0.8,
      reason: 'test',
    });
    expect('error' in result).toBe(false);
    const row = 'conflict' in result ? result.new : (result as { chat_id: string });
    expect(row.chat_id).toBe('derived-chat-123');
  });
});

// ── AC-14 (partial): getActiveMemory returns active-only ─────────────────────

describe('getActiveMemory — active-only filter (AC-14 partial)', () => {
  it('superseded and conflicted rows excluded; unrelated active row included', () => {
    const turnId = seedTurn('ac14-dl-chat', 'ac14-dl-sess', 'user', 'msg', nowTs());

    // Write two rows for the same label → first gets superseded by second.
    writeMemory({
      type: 'fact',
      content: { label: 'ac14 label', properties: { a: 1 } },
      source_turn_id: turnId,
      source_session_id: 'ac14-dl-sess',
      confidence: 0.5,
      reason: 'first',
    });
    writeMemory({
      type: 'fact',
      content: { label: 'ac14 label', properties: { a: 2 } },
      source_turn_id: turnId,
      source_session_id: 'ac14-dl-sess',
      confidence: 0.5,
      reason: 'second',
    });

    // One unrelated active row.
    writeMemory({
      type: 'preference',
      content: { label: 'ac14 unrelated', properties: { b: 1 } },
      source_turn_id: turnId,
      source_session_id: 'ac14-dl-sess',
      confidence: 0.8,
      reason: 'unrelated',
    });

    const active = getActiveMemory('ac14-dl-chat');
    // Only the latest version of 'ac14 label' (superseded_by IS NULL) + the unrelated one.
    expect(active.every((r) => r.superseded_by === null)).toBe(true);
    expect(active.every((r) => r.conflict_flag === 0)).toBe(true);
    // The old row (superseded) must NOT appear.
    const allRows = directDb
      .prepare(`SELECT * FROM memory_items WHERE chat_id = 'ac14-dl-chat'`)
      .all() as { superseded_by: number | null }[];
    const supersededCount = allRows.filter((r) => r.superseded_by !== null).length;
    expect(supersededCount).toBeGreaterThan(0); // sanity: superseded rows exist in DB
    expect(active.length).toBeLessThan(allRows.length); // but not in active set
  });
});

// ── AC-14: GET /api/memory route ─────────────────────────────────────────────

describe('GET /api/memory route (AC-14)', () => {
  it('?chat_id=X returns active-only rows, ts desc', async () => {
    const turnId = seedTurn('ac14-route-chat', 'ac14-r-sess', 'user', 'msg', nowTs());
    writeMemory({
      type: 'fact',
      content: { label: 'route test fact', properties: { k: 'v' } },
      source_turn_id: turnId,
      source_session_id: 'ac14-r-sess',
      confidence: 0.8,
      reason: 'test',
    });

    const res = await memoryRoute.GET(
      new Request('http://localhost/api/memory?chat_id=ac14-route-chat', { headers: H }),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as { superseded_by: number | null; conflict_flag: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.superseded_by === null)).toBe(true);
    expect(rows.every((r) => r.conflict_flag === 0)).toBe(true);
  });

  it('?chat_id=X&limit=1 returns at most 1 row', async () => {
    const turnId = seedTurn('ac14-limit-chat', 'ac14-lim-sess', 'user', 'msg', nowTs());
    writeMemory({
      type: 'fact',
      content: { label: 'limit fact a', properties: {} },
      source_turn_id: turnId,
      source_session_id: 'ac14-lim-sess',
      confidence: 0.7,
      reason: 'a',
    });
    writeMemory({
      type: 'fact',
      content: { label: 'limit fact b', properties: {} },
      source_turn_id: turnId,
      source_session_id: 'ac14-lim-sess',
      confidence: 0.7,
      reason: 'b',
    });

    const res = await memoryRoute.GET(
      new Request('http://localhost/api/memory?chat_id=ac14-limit-chat&limit=1', { headers: H }),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as unknown[];
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('missing chat_id → 422', async () => {
    const res = await memoryRoute.GET(
      new Request('http://localhost/api/memory', { headers: H }),
    );
    expect(res.status).toBe(422);
  });
});

// ── AC-15: memory_recent schema ──────────────────────────────────────────────
// Phase 5 (Recallatron) added the FTS `q` arm. Track 5 (semantic retrieval) then added the
// `mode` arm ('fts' | 'vector' | 'hybrid'). The schema is now {chat_id?, limit?, q?, mode?} —
// still no filter/type params (those are separate Track-2 tools).

describe('memory_recent schema {chat_id?, limit?, q?, mode?} (AC-15)', () => {
  it('inputSchema.properties is chat_id, limit, q, mode — no filter or type', () => {
    const tools = listMcpTools();
    const tool = tools.find((t) => t.name === 'memory_recent');
    expect(tool).toBeDefined();
    const props = Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props.sort()).toEqual(['chat_id', 'limit', 'q', 'mode'].sort());
    expect(props).not.toContain('filter');
    expect(props).not.toContain('type');
  });
});

// ── AC-10: All three new tools in listMcpTools() ─────────────────────────────

describe('three new MCP tools registered (AC-10)', () => {
  it('listMcpTools() includes summarize_and_archive, write_memory, memory_recent', () => {
    const tools = listMcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('summarize_and_archive');
    expect(names).toContain('write_memory');
    expect(names).toContain('memory_recent');
  });

  it('each new tool has a non-empty inputSchema', () => {
    const tools = listMcpTools();
    for (const name of ['summarize_and_archive', 'write_memory', 'memory_recent']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema).toBeTruthy();
      expect(typeof tool!.inputSchema).toBe('object');
    }
  });
});

// ── EC-10: Allowlist sync guard ───────────────────────────────────────────────
// If this test fails after adding a tool, update BOTH listMcpTools() AND this constant.

const EXPECTED_MCP_TOOLS = [
  'mcp__mot__mot_list_tickets',
  'mcp__mot__mot_get_ticket',
  'mcp__mot__mot_create_ticket',
  'mcp__mot__mot_update_ticket',
  'mcp__mot__mot_get_status',
  'mcp__mot__chat_log_turn',
  'mcp__mot__chat_recent',
  'mcp__mot__chat_search',
  'mcp__mot__summarize_and_archive',
  'mcp__mot__write_memory',
  'mcp__mot__memory_recent',
  // Track-2 (Recallatron Phase 5) tools.
  'mcp__mot__topic_threads',
  'mcp__mot__topic_thread_create',
  'mcp__mot__topic_thread_link',
  'mcp__mot__entity_get',
  'mcp__mot__entity_search',
  'mcp__mot__entity_related',
  'mcp__mot__entity_confirm',
  'mcp__mot__entity_supersede',
  'mcp__mot__procedural_notes_list',
  'mcp__mot__procedural_note_confirm',
  // Track-4 tools
  'mcp__mot__memory_context',
  'mcp__mot__graph_compact',
  'mcp__mot__topic_thread_summarize',
];

describe('allowlist sync guard (EC-10)', () => {
  it('listMcpTools() covers all tools in EXPECTED_MCP_TOOLS', () => {
    const registered = listMcpTools().map((t) => `mcp__mot__${t.name}`);
    for (const expected of EXPECTED_MCP_TOOLS) {
      expect(registered).toContain(expected);
    }
  });
});

// ── Pre-switch arg-shape guard (FR-14, EC-8) ──────────────────────────────────
// callMcpTool validates typed Track-2/3 args before the switch; a bad shape returns a
// structured { error: 'invalid_arg', arg } result instead of letting an `as` cast pass a
// wrong-typed value into the lib function. The result is text() of the error object, so we
// parse the JSON out of the ToolContent.

async function callError(name: string, args: Record<string, unknown>) {
  const out = await callMcpTool(name, args);
  return JSON.parse(out[0].text) as { error: string; arg?: string };
}

describe('arg-shape guard (FR-14, EC-8)', () => {
  it('AC-10a: entity_search with empty string q → invalid_arg/q', async () => {
    expect(await callError('entity_search', { q: '' })).toEqual({ error: 'invalid_arg', arg: 'q' });
  });

  it('AC-10b: procedural_note_confirm with non-integer id → invalid_arg/id (EC-8)', async () => {
    expect(await callError('procedural_note_confirm', { id: 'not-an-int' })).toEqual({ error: 'invalid_arg', arg: 'id' });
  });

  it('AC-10c: topic_thread_create missing title → invalid_arg/title', async () => {
    expect(await callError('topic_thread_create', { slug: 'ok' })).toEqual({ error: 'invalid_arg', arg: 'title' });
  });
});

// ── Boundary-signal contract (Prompt 1 / FR-3) ───────────────────────────────

describe('session boundary signal (FR-3)', () => {
  it('3h gap → logTurn returns non-null boundary_closed_session_id equal to old session', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const oldSessionId = 'bnd-old-session';
    seedTurn('bnd-chat', oldSessionId, 'user', 'old turn', threeHoursAgo);

    const result = logTurn('bnd-chat', 'user', 'new session turn');
    expect(result.boundary_closed_session_id).not.toBeNull();
    expect(result.boundary_closed_session_id).toBe(oldSessionId);
  });

  it('same-session turn → boundary_closed_session_id === null', () => {
    const r1 = logTurn('bnd-same-chat', 'user', 'first turn');
    const r2 = logTurn('bnd-same-chat', 'user', 'second turn same session');
    expect(r1.boundary_closed_session_id).toBeNull();
    expect(r2.boundary_closed_session_id).toBeNull();
  });
});

// ── getTurnsForSession (Prompt 1) ─────────────────────────────────────────────

describe('getTurnsForSession (FR-1)', () => {
  it('returns only turns for the given session_id in ASC id order', () => {
    const sessA = 'gts-sess-a';
    const sessB = 'gts-sess-b';
    const ts = nowTs();
    const id1 = seedTurn('gts-chat', sessA, 'user', 'turn A1', ts);
    const id2 = seedTurn('gts-chat', sessA, 'rheo', 'turn A2', ts);
    seedTurn('gts-chat', sessB, 'user', 'turn B1', ts);

    const turns = getTurnsForSession(sessA);
    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe(id1);
    expect(turns[1].id).toBe(id2);
    expect(turns.every((t) => t.session_id === sessA)).toBe(true);
  });

  it('unknown session_id → []', () => {
    expect(getTurnsForSession('unknown-session-xyz')).toEqual([]);
  });
});

// ── GET /api/conversation?session_id=X (Prompt 1) ────────────────────────────

describe('GET /api/conversation?session_id=X (FR-18)', () => {
  it('returns seeded turns for that session in ASC id order', async () => {
    const ts = nowTs();
    const sessId = 'conv-route-sess';
    const id1 = seedTurn('conv-route-chat', sessId, 'user', 'msg 1', ts);
    const id2 = seedTurn('conv-route-chat', sessId, 'rheo', 'msg 2', ts);

    const res = await convRoute.GET(
      new Request(`http://localhost/api/conversation?session_id=${sessId}`, { headers: H }),
    );
    expect(res.status).toBe(200);
    const turns = await res.json() as { id: number; session_id: string }[];
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0].id).toBe(id1);
    expect(turns[1].id).toBe(id2);
    expect(turns.every((t) => t.session_id === sessId)).toBe(true);
  });
});
