import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const { searchEntities, appendEntity } = await import('../../lib/graph');
const { levenshtein } = await import('../../lib/levenshtein');
// Phase 1 (FR-6): the resolve-or-create linker, called directly in the backfill-caller regression guard.
const { linkRelationDraft } = await import('../../scripts/backfill-relations');
type BotRelationDraftItem = import('../../lib/extraction').BotRelationDraftItem;
type EntityRecord = import('../../lib/graph').EntityRecord;

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
    relation_draft: null,
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

// Track 6 Phase 2 → Track 9 Phase 1 — processRelations. Driven end-to-end through runExtraction
// (processRelations is module-private), so the guard at extraction.ts and the whole resolve-or-create
// path are exercised. FR-6 promoted this from resolve-or-SKIP (matchByLabel) to resolve-or-CREATE
// (linkRelationDraft, create:true): an unresolved endpoint is MINTED, not dropped. Each case wants a
// clean graph so resolution is deterministic; this block points MOT_GRAPH_PATH at its own dir and
// resets the graph before each case.
describe('Track 6 Phase 2 / Track 9 Phase 1 — processRelations resolve-or-create edges', () => {
  let relDir: string;
  let relGraph: string;
  const prevGraphPath = process.env.MOT_GRAPH_PATH;

  beforeAll(() => {
    relDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-relations-'));
    relGraph = path.join(relDir, 'graph.jsonl');
    process.env.MOT_GRAPH_PATH = relGraph;
  });

  afterAll(() => {
    fs.rmSync(relDir, { recursive: true, force: true });
    if (prevGraphPath === undefined) delete process.env.MOT_GRAPH_PATH;
    else process.env.MOT_GRAPH_PATH = prevGraphPath;
  });

  function resetGraph(): void {
    fs.mkdirSync(path.dirname(relGraph), { recursive: true });
    fs.writeFileSync(relGraph, '');
  }

  // Seed a confirmed active entity so linkRelationDraft's resolveOrCreate finds it by exact label.
  // Returns the generated id.
  function seedEntity(
    label: string,
    type: 'Person' | 'Project' | 'Deadline' | 'Preference' | 'Fact' = 'Person',
  ): string {
    return appendEntity({
      type,
      label,
      properties: {},
      confidence: 1.0,
      confirmed: true,
      source: 'manual',
      valid_from: '2026-06-01T00:00:00.000Z',
      valid_until: null,
      superseded_by: null,
    }).id;
  }

  // Count op:'relate' lines currently in the graph file.
  function relatePatchCount(): number {
    if (!fs.existsSync(relGraph)) return 0;
    return fs
      .readFileSync(relGraph, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op?: string })
      .filter((r) => r.op === 'relate').length;
  }

  // Read the single relate patch (asserts there is exactly one first).
  function theRelatePatch(): { from: string; rel: string; to: string; confidence: number; source: string; confirmed: boolean } {
    const patches = fs
      .readFileSync(relGraph, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.op === 'relate');
    expect(patches).toHaveLength(1);
    return patches[0];
  }

  async function runRelationDraft(items: unknown, overrides: Record<string, unknown> = {}): Promise<void> {
    await runExtraction(
      digestRow({
        session_id: 's-rel',
        entity_draft: null,
        procedural_raw: null,
        relation_draft: typeof items === 'string' ? items : JSON.stringify(items),
        ...overrides,
      }),
    );
  }

  it('AC-6: confidence gate — 0.8499 appends no patch, 0.85 appends one', async () => {
    resetGraph();
    const robin = seedEntity('Taylor', 'Person');
    const sampleapp = seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'works_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.8499 },
    ]);
    expect(relatePatchCount()).toBe(0);

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'works_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.85 },
    ]);
    const patch = theRelatePatch();
    expect(patch.from).toBe(robin);
    expect(patch.to).toBe(sampleapp);
    expect(patch.rel).toBe('works_on');
    expect(patch.confirmed).toBe(false);
    expect(patch.source).toBe('session:s-rel');
  });

  // FR-6 (resolve-or-CREATE): an unresolved from_label is MINTED as a named node and linked, not
  // dropped. (Pre-FR-6 this test asserted "→ no patch"; the live path now grows the graph.)
  it('FR-6: from_label resolves to zero entities → mints the node and links', async () => {
    resetGraph();
    const sampleapp = seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'Nonexistent Person', from_type: 'Person', rel: 'works_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.95 },
    ]);

    // The edge is written and the missing endpoint is minted (confirmed:false).
    const patch = theRelatePatch();
    expect(patch.to).toBe(sampleapp);
    const minted = searchEntities('Nonexistent Person', 'Person');
    expect(minted).toHaveLength(1);
    expect(minted[0].confirmed).toBe(false);
    expect(patch.from).toBe(minted[0].id);
  });

  // FR-6: exact-label match resolves to the FIRST match (index.find), so a pre-existing node is
  // reused rather than duplicated — even when two same-label nodes exist, no new node is minted.
  // (Pre-FR-6 this asserted "→ no patch" on the ambiguity; resolve-or-create takes the first.)
  it('FR-6: from_label with a pre-existing exact match resolves to it (no mint)', async () => {
    resetGraph();
    const robin = seedEntity('Taylor', 'Person');
    seedEntity('Taylor', 'Person');
    const sampleapp = seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'works_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.95 },
    ]);

    const patch = theRelatePatch();
    expect(patch.from).toBe(robin); // first exact match reused
    expect(patch.to).toBe(sampleapp);
    // Still exactly two 'Taylor' Person nodes — no third was minted.
    expect(searchEntities('Taylor', 'Person')).toHaveLength(2);
  });

  it('AC-9: malformed relation_draft warns, does not throw, entity pass unaffected (EC5)', async () => {
    resetGraph();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // entity_draft is valid → its entity must still land despite the malformed relation_draft.
    await expect(
      runExtraction(
        digestRow({
          session_id: 's-rel',
          entity_draft: JSON.stringify([{ type: 'Person', label: 'Solo Person', properties: {}, confidence: 0.9 }]),
          procedural_raw: null,
          relation_draft: 'not json at all',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(relatePatchCount()).toBe(0);
    const people = searchEntities('', 'Person');
    expect(people.map((e) => e.label)).toContain('Solo Person');
    warn.mockRestore();
  });

  it('EC3: self-relation after resolution → no patch, logged', async () => {
    resetGraph();
    seedEntity('Taylor', 'Person');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'child_of', to_label: 'Taylor', to_type: 'Person', confidence: 0.95 },
    ]);

    expect(relatePatchCount()).toBe(0);
    expect(warn.mock.calls.flat().join(' ').toLowerCase()).toContain('self-relate');
    warn.mockRestore();
  });

  it('invalid rel verb → skip and log, no patch', async () => {
    resetGraph();
    seedEntity('Taylor', 'Person');
    seedEntity('SampleApp', 'Project');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'is_parent_of', to_label: 'SampleApp', to_type: 'Project', confidence: 0.95 },
    ]);

    expect(relatePatchCount()).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('is_parent_of');
    warn.mockRestore();
  });

  it('relation-only digest (entity_draft + procedural_raw null) reaches processRelations', async () => {
    resetGraph();
    const robin = seedEntity('Taylor', 'Person');
    const sampleapp = seedEntity('SampleApp', 'Project');

    // The guard at extraction.ts must let a relation-only row through (entity/procedural both null).
    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'works_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.9 },
    ]);

    const patch = theRelatePatch();
    expect(patch.from).toBe(robin);
    expect(patch.to).toBe(sampleapp);
  });

  it('type-hint disambiguation: same label, two types — from_type picks the Project node', async () => {
    resetGraph();
    seedEntity('SampleApp', 'Project');
    seedEntity('SampleApp', 'Fact');
    const projectNutri = searchEntities('SampleApp', 'Project')[0].id;
    seedEntity('Taylor', 'Person'); // a distinct `to` so it's not a self-relate
    const robin = searchEntities('Taylor', 'Person')[0].id;

    // With from_type:'Project' the typed pool has exactly one 'SampleApp' → resolves cleanly.
    await runRelationDraft([
      { from_label: 'SampleApp', from_type: 'Project', rel: 'belongs_to', to_label: 'Taylor', to_type: 'Person', confidence: 0.9 },
    ]);
    const patch = theRelatePatch();
    expect(patch.from).toBe(projectNutri);
    expect(patch.to).toBe(robin);
  });

  // FR-6: type-hint omitted, two 'SampleApp' nodes. resolveOrCreate falls back to fromType 'Fact'
  // (belongs_to has no REL_TYPE_HINT) and takes the same-type exact match → the Fact 'SampleApp'.
  // (Pre-FR-6 this was an ambiguous skip; resolve-or-create resolves it deterministically.)
  it('FR-6: type-hint omitted, same label two types → resolves same-type node, links', async () => {
    resetGraph();
    seedEntity('SampleApp', 'Project');
    seedEntity('SampleApp', 'Fact');
    const factNutri = searchEntities('SampleApp', 'Fact')[0].id;
    const robin = seedEntity('Taylor', 'Person');

    await runRelationDraft([
      { from_label: 'SampleApp', rel: 'belongs_to', to_label: 'Taylor', to_type: 'Person', confidence: 0.9 },
    ]);

    const patch = theRelatePatch();
    expect(patch.from).toBe(factNutri); // fromType defaults to Fact → same-type match
    expect(patch.to).toBe(robin);
    // No new 'SampleApp' minted — still exactly the two seeded.
    expect(searchEntities('SampleApp').length).toBe(2);
  });

  it('AC-19 (W1): mismatched type hint still resolves via typed-then-widen', async () => {
    resetGraph();
    // The only 'smallhost-box' node is stored as Fact; the bot guessed Project (wrong).
    const box = seedEntity('smallhost-box', 'Fact');
    const sampleapp = seedEntity('SampleApp', 'Project');

    // to_type:'Project' → typed pool has zero 'smallhost-box' → widen to type-agnostic → Fact node.
    await runRelationDraft([
      { from_label: 'SampleApp', from_type: 'Project', rel: 'hosted_on', to_label: 'smallhost-box', to_type: 'Project', confidence: 0.9 },
    ]);

    const patch = theRelatePatch();
    expect(patch.from).toBe(sampleapp);
    expect(patch.to).toBe(box);
  });

  // FR-6 (W2 preserved): 'mot' is Levenshtein-1 from stored 'moi', but resolution is EXACT-only —
  // 'mot' must NOT wire to 'moi'. Under resolve-or-create it mints a DISTINCT 'mot' node and links
  // there instead of dropping the edge. The no-fuzzy-match invariant (the original 0-edge bug guard)
  // is what keeps 'mot' and 'moi' separate. (Pre-FR-6 this asserted "→ no patch".)
  it('FR-6 / W2: Levenshtein-1 decoy does NOT resolve to the near node — mints a distinct node', async () => {
    resetGraph();
    const moi = seedEntity('moi', 'Project');
    const sampleapp = seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'mot', from_type: 'Project', rel: 'depends_on', to_label: 'SampleApp', to_type: 'Project', confidence: 0.95 },
    ]);

    const patch = theRelatePatch();
    expect(patch.to).toBe(sampleapp);
    // 'mot' was minted as its own node — it did NOT collapse into the 'moi' decoy.
    const mot = searchEntities('mot', 'Project');
    expect(mot).toHaveLength(1);
    expect(patch.from).toBe(mot[0].id);
    expect(patch.from).not.toBe(moi);
  });

  it('infra-edge fixture: a complete owns item appends exactly one relate patch', async () => {
    resetGraph();
    const robin = seedEntity('Taylor', 'Person');
    const sampleapp = seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'Taylor', from_type: 'Person', rel: 'owns', to_label: 'SampleApp', to_type: 'Project', confidence: 0.9 },
    ]);

    expect(relatePatchCount()).toBe(1);
    const patch = theRelatePatch();
    expect(patch.rel).toBe('owns');
    expect(patch.from).toBe(robin);
    expect(patch.to).toBe(sampleapp);
  });
});

// Track 9 Phase 1 (FR-6) — the resolve-or-CREATE promotion of processRelations. The three cases the
// Phase 1 spec names: (1) an unresolved endpoint MINTS + links (was a 0-edge drop); (2) an exact-label
// endpoint resolves without minting a duplicate; (3) the backfill caller's create:false path still
// resolves-only + skips-on-miss (regression guard on the generalized `source` signature).
describe('Track 9 Phase 1 — FR-6 resolve-or-create in processRelations', () => {
  let p1Dir: string;
  let p1Graph: string;
  const prevGraphPath = process.env.MOT_GRAPH_PATH;

  beforeAll(() => {
    p1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-p1-'));
    p1Graph = path.join(p1Dir, 'graph.jsonl');
    process.env.MOT_GRAPH_PATH = p1Graph;
  });

  afterAll(() => {
    fs.rmSync(p1Dir, { recursive: true, force: true });
    if (prevGraphPath === undefined) delete process.env.MOT_GRAPH_PATH;
    else process.env.MOT_GRAPH_PATH = prevGraphPath;
  });

  function resetGraph(): void {
    fs.mkdirSync(path.dirname(p1Graph), { recursive: true });
    fs.writeFileSync(p1Graph, '');
  }

  function seedEntity(
    label: string,
    type: 'Person' | 'Project' | 'Deadline' | 'Preference' | 'Fact' = 'Person',
  ): string {
    return appendEntity({
      type,
      label,
      properties: {},
      confidence: 1.0,
      confirmed: true,
      source: 'manual',
      valid_from: '2026-06-01T00:00:00.000Z',
      valid_until: null,
      superseded_by: null,
    }).id;
  }

  // All op:'relate' patch lines currently in the graph file.
  function relatePatches(): Array<{ from: string; rel: string; to: string }> {
    if (!fs.existsSync(p1Graph)) return [];
    return fs
      .readFileSync(p1Graph, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.op === 'relate');
  }

  async function runRelationDraft(items: unknown): Promise<void> {
    await runExtraction(
      digestRow({
        session_id: 's-p1',
        entity_draft: null,
        procedural_raw: null,
        relation_draft: JSON.stringify(items),
      }),
    );
  }

  it('FR-6: an unresolved endpoint mints a confirmed:false node (source session:) and links it', async () => {
    resetGraph();
    const sampleapp = seedEntity('SampleApp', 'Project'); // 'Taylor' deliberately absent

    await runRelationDraft([
      { from_label: 'Taylor', rel: 'works_on', to_label: 'SampleApp', confidence: 0.9, from_type: 'Person', to_type: 'Project' },
    ]);

    // (a) A 'Taylor' Person node was minted — unconfirmed, sourced to the live session.
    const robins = searchEntities('Taylor', 'Person');
    expect(robins).toHaveLength(1);
    expect(robins[0].confirmed).toBe(false);
    expect(robins[0].source.startsWith('session:')).toBe(true);

    // (b) A relate op line links Taylor → SampleApp (was 0 edges pre-FR-6).
    const edges = relatePatches();
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe(robins[0].id);
    expect(edges[0].to).toBe(sampleapp);
    expect(edges[0].rel).toBe('works_on');
  });

  it('FR-6: an exact-label endpoint resolves without minting a duplicate', async () => {
    resetGraph();
    const robin = seedEntity('Taylor', 'Person'); // pre-seeded this time
    seedEntity('SampleApp', 'Project');

    await runRelationDraft([
      { from_label: 'Taylor', rel: 'works_on', to_label: 'SampleApp', confidence: 0.9, from_type: 'Person', to_type: 'Project' },
    ]);

    // Exactly one 'Taylor' Person — the seeded one was reused, no duplicate minted.
    const robins = searchEntities('Taylor', 'Person');
    expect(robins).toHaveLength(1);
    expect(robins[0].id).toBe(robin);
    // And the edge points at the pre-existing node.
    expect(relatePatches()[0].from).toBe(robin);
  });

  it('backfill caller regression: create:false still resolves-only and skips on a miss (no mint)', () => {
    resetGraph();
    // A pre-seeded index with only SampleApp; 'Taylor' is absent, so the endpoint misses.
    const index: EntityRecord[] = [
      {
        id: 'sampleapp-1',
        type: 'Project',
        label: 'SampleApp',
        properties: {},
        confidence: 1.0,
        confirmed: true,
        source: 'manual',
        valid_from: '2026-06-01T00:00:00.000Z',
        valid_until: null,
        superseded_by: null,
      },
    ];
    const items: BotRelationDraftItem[] = [
      { from_label: 'Taylor', rel: 'works_on', to_label: 'SampleApp', confidence: 0.9, from_type: 'Person', to_type: 'Project' },
    ];

    // The generalized `source` param carries the backfill's session provenance unchanged.
    const result = linkRelationDraft(JSON.stringify(items), 'session:test-sid', index, {
      dryRun: false,
      create: false,
      seenEdges: new Set<string>(),
    });

    // create:false → the unresolved 'Taylor' endpoint is skipped, nothing minted, no edge written.
    expect(result.entitiesCreated).toHaveLength(0);
    expect(result.edgesWritten).toBe(0);
    expect(result.skipped.some((s) => s.reason === 'from-unresolved')).toBe(true);
    // The direct call with create:false writes nothing to the graph file either.
    expect(relatePatches()).toHaveLength(0);
  });
});
