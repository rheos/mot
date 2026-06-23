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
const { levenshtein } = await import('../../lib/levenshtein');

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

// The dedup signal (Track 3 Phase 3) — processEntities flags probable_duplicate_of on the
// incoming entity when a same-type active entity is a near-match (edit distance ≤ 2 OR a
// prefix/suffix with both labels ≥ 4 chars). The entity is ALWAYS appended; the flag is advisory
// (FR-5, no suppression). Same-batch asymmetry is intentional: appendEntity writes immediately,
// so the next item's scan re-reads the file and sees the just-appended entity.
describe('Recallatron Track 3 Phase 3 — semantic dedup signal at extraction', () => {
  // These cases want a clean graph per test. Point MOT_GRAPH_PATH at a dedicated dir for this
  // block (graphPath() reads the env lazily on every call) so they don't share — or race the
  // teardown of — the first describe's temp file. Restore the env afterwards.
  let dedupDir: string;
  let dedupGraph: string;
  const prevGraphPath = process.env.MOT_GRAPH_PATH;

  beforeAll(() => {
    dedupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-dedup-'));
    dedupGraph = path.join(dedupDir, 'graph.jsonl');
    process.env.MOT_GRAPH_PATH = dedupGraph;
  });

  afterAll(() => {
    fs.rmSync(dedupDir, { recursive: true, force: true });
    if (prevGraphPath === undefined) delete process.env.MOT_GRAPH_PATH;
    else process.env.MOT_GRAPH_PATH = prevGraphPath;
  });

  // Truncate (recreating the dir defensively) before each case for a deterministic scan.
  function resetGraph(): void {
    fs.mkdirSync(path.dirname(dedupGraph), { recursive: true });
    fs.writeFileSync(dedupGraph, '');
  }

  // Drive a single-item extraction batch of one entity (Person by default), returning the
  // entity record now in the graph. Confidence 0.9 clears the EC-5 gate.
  async function extractOne(
    label: string,
    type: 'Person' | 'Project' | 'Deadline' | 'Preference' | 'Fact' = 'Person',
  ): Promise<void> {
    await runExtraction(
      digestRow({
        entity_draft: JSON.stringify([{ type, label, properties: {}, confidence: 0.9 }]),
        procedural_raw: null,
      }),
    );
  }

  it('AC-6: flags probable_duplicate_of when a same-type label is within edit distance ≤ 2', async () => {
    resetGraph();

    await extractOne('Alice');
    const first = searchEntities('', 'Person');
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    // "Alica" vs "Alice" — edit distance 1, ≤ 2 gate fires.
    await extractOne('Alica');

    const all = searchEntities('', 'Person');
    expect(all).toHaveLength(2);

    const second = all.find((e) => e.label === 'Alica')!;
    expect(second.properties.probable_duplicate_of).toContain(firstId);

    // The first entity is unchanged — no flag back-written onto it (the scan only flags the incoming).
    const firstAfter = all.find((e) => e.id === firstId)!;
    expect(firstAfter.properties.probable_duplicate_of).toBeUndefined();
  });

  it('AC-7: prefix/suffix gate fires past the distance gate when both labels are ≥ 4 chars', async () => {
    resetGraph();

    await extractOne('Alex');
    const first = searchEntities('', 'Person');
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    // "Alex Goodwin" starts with "Alex" (len 6, ≥ 4). Edit distance is 8 (> 2), so the
    // prefix gate — not the distance gate — is what catches this.
    await extractOne('Alex Goodwin');

    const second = searchEntities('', 'Person').find((e) => e.label === 'Alex Goodwin')!;
    expect(second.properties.probable_duplicate_of).toContain(firstId);
  });

  it('AC-7: the ≥ 4-char length floor blocks the prefix/suffix gate for short labels', async () => {
    resetGraph();

    // "Al" (len 2, < 4) vs "Alice" — edit distance 3 (> 2). "Alice" starts with "Al", but the
    // shorter label is below the 4-char floor, so the prefix gate is blocked → no flag.
    await extractOne('Al');
    await extractOne('Alice');

    const second = searchEntities('', 'Person').find((e) => e.label === 'Alice')!;
    expect(second.properties.probable_duplicate_of).toBeUndefined();
  });

  it('AC-8: no same-type near-match → no probable_duplicate_of key at all', async () => {
    resetGraph();

    // A lone entity with nothing similar in the graph. The dedup scan finds no match and must
    // not add the key (not even an empty array).
    await extractOne('Zephyrine');

    const only = searchEntities('', 'Person');
    expect(only).toHaveLength(1);
    expect('probable_duplicate_of' in only[0].properties).toBe(false);
  });

  it('only flags SAME-type entities — a different-type near-match is ignored', async () => {
    resetGraph();

    // "Alice" the Person and "Alica" the Project are within edit distance 1, but the dedup scan
    // is scoped to item.type, so the Project does not pick up the Person as a duplicate.
    await extractOne('Alice', 'Person');
    await extractOne('Alica', 'Project');

    const project = searchEntities('', 'Project').find((e) => e.label === 'Alica')!;
    expect(project.properties.probable_duplicate_of).toBeUndefined();
  });
});

describe('levenshtein edit distance (lib/levenshtein)', () => {
  it('identical strings → 0', () => {
    expect(levenshtein('alice', 'alice')).toBe(0);
  });

  it('single substitution → 1', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('"Alica" vs "Alice" → 1 (the ≤ 2 gate fires)', () => {
    expect(levenshtein('alica', 'alice')).toBe(1);
  });

  it('"Alex" vs "Alex Goodwin" → 8 (caught by prefix, not distance)', () => {
    expect(levenshtein('alex', 'alex goodwin')).toBe(8);
  });
});
