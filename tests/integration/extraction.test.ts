import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Phase 4 — the extraction pass (lib/extraction.ts). runExtraction fans a persisted
// DigestRow out into BOTH stores, so this file combines both harnesses:
//   - the entity graph reads MOT_GRAPH_PATH lazily (lib/graph) → point it at a temp .jsonl file.
//   - procedural notes hit the SQLite DB via getDb() (lib/procedural) → set DATABASE_URL to a
//     fresh temp DB and drive migrate_db so 0005_procedural_notes lands. procedural_notes.
//     source_session_id FKs session_digest(session_id), so we seed one session up front.
// Both env vars are set BEFORE the first dynamic import (the same lazy-env ordering the
// graph.test.ts / procedural.test.ts harnesses rely on).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-extraction-'));
const tmpDbPath = path.join(tmpDir, 'extraction.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const { migrate_db, getDb } = await import('../../db/client');
const { runExtraction, TEST_DIGEST_FIXTURE } = await import('../../lib/extraction');
const { searchEntities } = await import('../../lib/graph');

const SESSION_ID = 's-extract';
const CHAT_ID = 'c1';

// The full DigestRow shape (confirmed against lib/digest.ts). entity_draft/procedural_raw are
// JSON TEXT on the row — the synthetic rows below stringify the fixture into them, exactly as
// upsertDigest persists what the bot POSTs.
type DigestRow = Parameters<typeof runExtraction>[0];

function digestRow(overrides: Partial<DigestRow> = {}): DigestRow {
  return {
    id: 1,
    session_id: SESSION_ID,
    chat_id: CHAT_ID,
    summary: 'A session about Alex and SampleApp.',
    ts: '2026-06-22T10:00:00.000Z',
    topics: null,
    entity_draft: null,
    procedural_raw: null,
    parse_error: 0,
    turn_count: 5,
    ...overrides,
  };
}

// Read the temp graph file directly (loadGraph folds supersession; searchEntities is the public
// read). Empty query → matches all active records.
function graphLineCount(): number {
  if (!fs.existsSync(graphFile)) return 0;
  return fs
    .readFileSync(graphFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '').length;
}

describe('Recallatron Phase 4 — extraction pass (lib/extraction)', () => {
  beforeAll(() => {
    migrate_db();
    // Seed the FK target for procedural_notes.source_session_id.
    getDb()
      .prepare(
        `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
         VALUES (?, ?, 'Extract session', '2026-06-22T09:00:00.000Z', 5)`,
      )
      .run(SESSION_ID, CHAT_ID);
  });

  afterAll(() => {
    getDb().close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MOT_GRAPH_PATH;
  });

  it('TEST_DIGEST_FIXTURE: gates entities at 0.85, inserts unique notes unconfirmed, skips the duplicate', async () => {
    const row = digestRow({
      entity_draft: JSON.stringify(TEST_DIGEST_FIXTURE.entity_draft),
      procedural_raw: JSON.stringify(TEST_DIGEST_FIXTURE.procedural_raw),
    });

    await runExtraction(row);

    // Two entities clear the >= 0.85 gate (0.9 and 0.85); the 0.8499 one does not (EC-5).
    const entities = searchEntities('');
    expect(entities).toHaveLength(2);
    expect(graphLineCount()).toBe(2);

    const labels = entities.map((e) => e.label).sort();
    expect(labels).toEqual(['Alex Goodwin', 'SampleApp']);
    expect(entities.map((e) => e.label)).not.toContain('Taylor prefers bullet replies maybe');

    // AC-7 — every extraction-pass entity is unconfirmed, sourced to the session.
    for (const e of entities) {
      expect(e.confirmed).toBe(false);
      expect(e.source).toBe(`session:${SESSION_ID}`);
      expect(e.superseded_by).toBeNull();
      expect(e.valid_until).toBeNull();
    }

    // The unique procedural note was inserted unconfirmed (AC-8); the duplicate (same note text,
    // different category) was dedup-skipped by insertCandidate (OQ-5).
    const notes = getDb()
      .prepare(`SELECT * FROM procedural_notes WHERE source_session_id = ?`)
      .all(SESSION_ID) as { confirmed: number; note_norm: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].confirmed).toBe(0);
    expect(notes[0].note_norm).toBe('robin prefers bullet replies for ticket lists');
  });

  it('parse_error=1 is a no-op — no entities, no notes written', async () => {
    const before = graphLineCount();
    const beforeNotes = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;

    const row = digestRow({
      session_id: 's-parseerr',
      parse_error: 1,
      entity_draft: JSON.stringify(TEST_DIGEST_FIXTURE.entity_draft),
      procedural_raw: JSON.stringify(TEST_DIGEST_FIXTURE.procedural_raw),
    });
    await runExtraction(row);

    expect(graphLineCount()).toBe(before);
    const afterNotes = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;
    expect(afterNotes).toBe(beforeNotes);
  });

  it('entity_draft=null and procedural_raw=null is a no-op (structural digest path)', async () => {
    const before = graphLineCount();
    const beforeNotes = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;

    await runExtraction(digestRow({ entity_draft: null, procedural_raw: null }));

    expect(graphLineCount()).toBe(before);
    const afterNotes = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;
    expect(afterNotes).toBe(beforeNotes);
  });

  it('malformed entity_draft does not throw and still processes valid procedural_raw (EC-4)', async () => {
    const notesBefore = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;
    const graphBefore = graphLineCount();

    const row = digestRow({
      entity_draft: 'not valid json',
      procedural_raw: JSON.stringify([
        { category: 'workflow', note: 'A fresh note from a malformed-entity digest', confidence: 0.9 },
      ]),
    });

    // Must not throw despite the malformed entity_draft.
    await expect(runExtraction(row)).resolves.toBeUndefined();

    // No new entity (entity_draft was skipped), but the valid procedural note landed.
    expect(graphLineCount()).toBe(graphBefore);
    const notesAfter = (
      getDb().prepare(`SELECT count(*) AS c FROM procedural_notes`).get() as { c: number }
    ).c;
    expect(notesAfter).toBe(notesBefore + 1);
  });
});
