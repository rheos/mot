import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Track 4 — historical backfill (scripts/backfill-extraction.ts). Covers AC-10 (dry-run
// counts + writes nothing) and AC-11 (the GAP #2 idempotency skip-set: a re-run appends NO duplicate
// entities and NO duplicate procedural rows, and logs every qualifying digest as already-extracted).
//
// Harness mirrors extraction.test.ts: runBackfill fans each DigestRow out via runExtraction, which
// writes to BOTH stores — the entity graph (MOT_GRAPH_PATH, a temp .jsonl) and procedural_notes
// (DATABASE_URL, a temp DB). Both env vars are set BEFORE the first dynamic import (the lazy-env
// ordering the other Recallatron harnesses rely on), so the real ontology/graph.jsonl and dev DB
// are NEVER touched. procedural_notes.source_session_id FKs session_digest(session_id), so every
// digest we back-fill is first inserted into session_digest.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-backfill-'));
const tmpDbPath = path.join(tmpDir, 'backfill.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const { migrate_db, getDb } = await import('../../db/client');
const { graphEntitySources } = await import('../../lib/graph-compact');
const { parseArgs, dryRunCounts, runBackfill, qualifyingRows } = await import(
  '../../scripts/backfill-extraction'
);

// Count entity records in the temp graph (one JSON line per record; patch lines have an `op`).
function graphEntityCount(): number {
  if (!fs.existsSync(graphFile)) return 0;
  return fs
    .readFileSync(graphFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((r) => r.op === undefined).length; // entity record, not a supersede/confirm patch
}

function proceduralCount(): number {
  return (
    getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
  ).c;
}

// Insert one session_digest row. entity_draft / procedural_raw are JSON TEXT, exactly as
// upsertDigest persists what the bot POSTs.
function insertDigest(row: {
  session_id: string;
  ts: string;
  parse_error?: number;
  entity_draft?: string | null;
  procedural_raw?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_digest
         (session_id, chat_id, summary, ts, topics, entity_draft, procedural_raw, parse_error, turn_count)
       VALUES (?, 'c1', 'backfill test digest', ?, NULL, ?, ?, ?, 5)`,
    )
    .run(
      row.session_id,
      row.ts,
      row.entity_draft ?? null,
      row.procedural_raw ?? null,
      row.parse_error ?? 0,
    );
}

// A single high-confidence entity (clears the >= 0.85 EC-5 gate) JSON-encoded for entity_draft.
function entityDraft(label: string): string {
  return JSON.stringify([{ type: 'Person', label, properties: {}, confidence: 0.9 }]);
}

// A single procedural note JSON-encoded for procedural_raw. note_norm dedups GLOBALLY across
// sessions, so each digest must carry DISTINCT text for both to insert on the first run.
function proceduralRaw(note: string): string {
  return JSON.stringify([{ category: 'workflow', note, confidence: 0.9 }]);
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

describe('scripts/backfill-extraction — parseArgs', () => {
  it('defaults beforeDate to 2026-06-22 and dryRun to false', () => {
    expect(parseArgs(['node', 'backfill'])).toEqual({ dryRun: false, beforeDate: '2026-06-22' });
  });

  it('parses --dry-run and --before <ISO>', () => {
    expect(parseArgs(['node', 'backfill', '--dry-run', '--before', '2026-01-01'])).toEqual({
      dryRun: true,
      beforeDate: '2026-01-01',
    });
  });
});

describe('AC-10 — dry-run reports counts and writes NOTHING', () => {
  const CUTOFF = '2026-06-22';

  beforeAll(() => {
    // 2 qualifying rows (parse_error=0, ts < cutoff). One has entity_draft (actionable); the other
    // is structural-only (entity_draft AND procedural_raw null). 1 excluded row (ts >= cutoff).
    insertDigest({ session_id: 'ac10-actionable', ts: '2026-05-01T10:00:00.000Z', entity_draft: entityDraft('Dry Run Person') });
    insertDigest({ session_id: 'ac10-structural', ts: '2026-05-02T10:00:00.000Z' });
    insertDigest({ session_id: 'ac10-excluded', ts: '2026-06-25T10:00:00.000Z', entity_draft: entityDraft('Excluded Person') });
  });

  it('counts 2 qualifying rows, 1 actionable, and never writes to the graph or procedural tables', () => {
    const graphBefore = graphEntityCount();
    const proceduralBefore = proceduralCount();

    const rows = qualifyingRows(CUTOFF);
    // Only this test's two pre-cutoff rows qualify (the AC-11 block inserts later, in its own beforeAll).
    expect(rows.map((r) => r.session_id).sort()).toEqual(['ac10-actionable', 'ac10-structural']);

    const extractedSources = graphEntitySources(graphFile);
    const counts = dryRunCounts(rows, extractedSources);

    expect(counts.qualifying).toBe(2);
    expect(counts.actionable).toBe(1); // only ac10-actionable carries entity_draft
    expect(counts.structural).toBe(1); // ac10-structural is the no-op
    expect(counts.alreadyExtracted).toBe(0);
    expect(counts.netNew).toBe(2);

    // The dry-run path is read-only: nothing landed in either store.
    expect(graphEntityCount()).toBe(graphBefore);
    expect(proceduralCount()).toBe(proceduralBefore);
  });
});

describe('AC-11 — real-run idempotency via the GAP #2 skip-set (entities AND procedural)', () => {
  const CUTOFF = '2026-06-22';

  beforeAll(() => {
    // Two actionable qualifying rows: each carries an entity_draft AND a DISTINCT procedural note
    // (distinct so both procedural rows insert on the first run — note_norm dedups globally).
    insertDigest({
      session_id: 'ac11-a',
      ts: '2026-04-01T10:00:00.000Z',
      entity_draft: entityDraft('Backfill Person A'),
      procedural_raw: proceduralRaw('Taylor backfill note alpha'),
    });
    insertDigest({
      session_id: 'ac11-b',
      ts: '2026-04-02T10:00:00.000Z',
      entity_draft: entityDraft('Backfill Person B'),
      procedural_raw: proceduralRaw('Taylor backfill note beta'),
    });
  });

  it('first run appends entities + procedural rows; re-run leaves BOTH counts unchanged and skips every digest', async () => {
    // Scope to only this block's two rows (other blocks inserted their own digests on the same DB).
    const allRows = qualifyingRows(CUTOFF);
    const rows = allRows.filter((r) => r.session_id === 'ac11-a' || r.session_id === 'ac11-b');
    expect(rows).toHaveLength(2);

    const graphBefore = graphEntityCount();
    const proceduralBefore = proceduralCount();

    // ── First run: skip-set is empty for these sessions, so both digests are processed. ──
    const sources1 = graphEntitySources(graphFile);
    const firstTally = await runBackfill(rows, sources1);
    expect(firstTally.processed).toBe(2);
    expect(firstTally.skippedAlreadyExtracted).toBe(0);
    expect(firstTally.errored).toBe(0);

    const graphAfterFirst = graphEntityCount();
    const proceduralAfterFirst = proceduralCount();
    // Each digest appended one entity and one procedural note.
    expect(graphAfterFirst).toBe(graphBefore + 2);
    expect(proceduralAfterFirst).toBe(proceduralBefore + 2);

    // ── Re-run: rebuild the skip-set (now populated by the first run) and run again. ──
    const logSpy = vi.spyOn(console, 'log');
    const sources2 = graphEntitySources(graphFile);
    // The skip-set now carries session:ac11-a and session:ac11-b.
    expect(sources2.has('session:ac11-a')).toBe(true);
    expect(sources2.has('session:ac11-b')).toBe(true);

    const secondTally = await runBackfill(rows, sources2);

    // THE proof: the re-run skipped every qualifying digest and processed none.
    expect(secondTally.processed).toBe(0);
    expect(secondTally.skippedAlreadyExtracted).toBe(rows.length); // === 2
    expect(secondTally.errored).toBe(0);

    // BOTH counts are unchanged on the re-run — no duplicate entities (skip-set), no duplicate
    // procedural rows (skip-set short-circuits before runExtraction; note_norm would also dedup).
    expect(graphEntityCount()).toBe(graphAfterFirst);
    expect(proceduralCount()).toBe(proceduralAfterFirst);

    // Every qualifying digest was logged as already-extracted on the re-run.
    const skipLogs = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('skip (already-extracted)'));
    expect(skipLogs.some((m) => m.includes('ac11-a'))).toBe(true);
    expect(skipLogs.some((m) => m.includes('ac11-b'))).toBe(true);
    logSpy.mockRestore();
  });
});

// FR-5.30 / AC-12: importing the script module must NOT boot the DB or trip process.exit (the IIFE
// is guarded by isDirectRun). The dynamic import at the top of this file already exercised that —
// if the IIFE fired on import, this suite would never have started.
describe('FR-5.30 — importing the script module does not run the IIFE', () => {
  it('exposed the helpers without executing main()', () => {
    expect(typeof parseArgs).toBe('function');
    expect(typeof runBackfill).toBe('function');
  });
});
