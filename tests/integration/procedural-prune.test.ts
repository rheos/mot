import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 4 (Prompt 3) — prunePendingProcedural (AC-7) + the graph_compact admin MCP tool.
//
// Two harnesses in one file (like mcp-tools.test.ts / extraction.test.ts):
//   - prunePendingProcedural hits SQLite via getDb() → set DATABASE_URL to a fresh temp DB and
//     run migrate_db() so 0005_procedural_notes lands. We insert rows by raw SQL (not
//     insertCandidate) so created_at can be back-dated to make a candidate stale.
//   - graph_compact reads MOT_GRAPH_PATH lazily → point it at a temp .jsonl and drive the tool
//     through callMcpTool(), the same real round-trip mcp-tools.test.ts uses. Resolving the
//     path correctly and returning { ok: true } is the smoke assertion; we also confirm the
//     file was actually compacted (a superseded record is dropped).
// Neither harness ever touches the dev DB or the real ontology/ directory.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-proc-prune-'));
const tmpDbPath = path.join(tmpDir, 'proc-prune.db');
process.env.DATABASE_URL = tmpDbPath;

const { migrate_db, getDb } = await import('../../db/client');
const { prunePendingProcedural } = await import('../../lib/procedural');

const SESSION_ID = 's-prune';

// Insert a procedural_notes row directly so created_at is fully under our control (insertCandidate
// always stamps nowIso(), which can't produce a stale row).
function insertNote(opts: {
  note: string;
  confirmed: 0 | 1;
  createdAt: string;
  mentionCount?: number;
}): number {
  const norm = opts.note.trim().toLowerCase();
  const r = getDb()
    .prepare(
      `INSERT INTO procedural_notes
         (category, note, note_norm, source_session_id, confirmed, confirmed_at,
          superseded_by, mention_count, chat_id, created_at, ts)
       VALUES ('workflow', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      opts.note,
      norm,
      SESSION_ID,
      opts.confirmed,
      opts.mentionCount ?? 1,
      opts.createdAt,
      opts.createdAt,
    );
  return Number(r.lastInsertRowid);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function exists(id: number): boolean {
  const row = getDb()
    .prepare(`SELECT id FROM procedural_notes WHERE id = ?`)
    .get(id) as { id: number } | undefined;
  return row !== undefined;
}

describe('prunePendingProcedural (AC-7)', () => {
  beforeAll(() => {
    migrate_db();
    // source_session_id has an FK to session_digest(session_id).
    getDb()
      .prepare(
        `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
         VALUES (?, 'c1', 'Prune session', '2026-05-01T10:00:00.000Z', 1)`,
      )
      .run(SESSION_ID);
  });

  afterAll(() => {
    getDb().close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes only stale unconfirmed candidates; confirmed + fresh survive; returns the count', () => {
    const confirmedId = insertNote({
      note: 'Always run typecheck before commit',
      confirmed: 1,
      createdAt: daysAgoIso(31), // old but confirmed ⇒ must survive
    });
    const staleId = insertNote({
      note: 'Prefer named exports here',
      confirmed: 0,
      createdAt: daysAgoIso(31), // unconfirmed + older than cutoff ⇒ deleted
    });
    const freshId = insertNote({
      note: 'Use absolute paths in scripts',
      confirmed: 0,
      createdAt: daysAgoIso(1), // unconfirmed but fresh ⇒ survives
    });

    const deleted = prunePendingProcedural(30);

    expect(deleted).toBe(1);
    expect(exists(staleId)).toBe(false);
    expect(exists(confirmedId)).toBe(true);
    expect(exists(freshId)).toBe(true);
  });
});

describe('graph_compact MCP tool (smoke)', () => {
  let graphDir: string;
  let graphFile: string;

  beforeEach(() => {
    graphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-compact-tool-'));
    graphFile = path.join(graphDir, 'graph.jsonl');
    process.env.MOT_GRAPH_PATH = graphFile;
  });

  afterEach(() => {
    fs.rmSync(graphDir, { recursive: true, force: true });
    delete process.env.MOT_GRAPH_PATH;
  });

  it('resolves the graph path and returns { ok: true }, actually compacting the file', async () => {
    // Lazy import so the freshly-set MOT_GRAPH_PATH is the one the tool resolves.
    const { callMcpTool } = await import('../../lib/mcp-tools');
    const { appendEntity, appendSupersede } = await import('../../lib/graph');

    const base = {
      type: 'Fact' as const,
      properties: {},
      valid_from: '2026-06-22T00:00:00.000Z',
      valid_until: null,
      confidence: 0.9,
      source: 'manual',
      superseded_by: null,
      confirmed: true,
    };
    appendEntity({ ...base, label: 'Active entity' });
    const superseded = appendEntity({ ...base, label: 'Doomed entity' });
    const replacement = appendEntity({ ...base, label: 'Replacement entity' });
    appendSupersede(superseded.id, replacement.id);

    // Before: 4 raw lines (3 entities + 1 supersede patch).
    const before = fs.readFileSync(graphFile, 'utf8').trim().split('\n');
    expect(before.length).toBe(4);

    const content = await callMcpTool('graph_compact', {});
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    const payload = JSON.parse(content[0].text) as { ok: boolean; message: string };
    expect(payload.ok).toBe(true);

    // After: superseded record dropped, patch folded ⇒ 2 active survivors. This only holds if the
    // tool resolved MOT_GRAPH_PATH (not the real ontology path) and ran compactGraph against it.
    const after = fs.readFileSync(graphFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(after.length).toBe(2);
    const labels = after.map((l) => (JSON.parse(l) as { label: string }).label).sort();
    expect(labels).toEqual(['Active entity', 'Replacement entity']);
  });
});
