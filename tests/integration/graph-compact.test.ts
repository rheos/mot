import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Track 4 — graph maintenance (lib/graph-compact): compactGraph, prunePendingEntities,
// graphEntitySources. Covers AC-8/9, EC-3/6/9/10, and the graphEntitySources status-agnostic read.
//
// lib/graph + lib/graph-compact read MOT_GRAPH_PATH lazily on every call (same lazy-env pattern as
// lib/graph.test.ts), so each test points it at a fresh temp file and NEVER touches the real
// ontology/ directory. compactGraph/graphEntitySources also take the path explicitly — we pass the
// same temp file so both access routes agree.

let tmpDir: string;
let graphFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-compact-'));
  graphFile = path.join(tmpDir, 'graph.jsonl');
  process.env.MOT_GRAPH_PATH = graphFile;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
  vi.restoreAllMocks();
});

// Lazily resolved at call time (env is set in beforeEach above).
const { compactGraph, prunePendingEntities, graphEntitySources } = await import(
  '../../lib/graph-compact'
);
const {
  appendEntity,
  appendSupersede,
  searchEntities,
  appendRelate,
  appendConfirmRelate,
  appendUnrelate,
  loadGraph,
  relatedEntities,
} = await import('../../lib/graph');

type EntityInput = Parameters<typeof appendEntity>[0];

// A minimal valid entity record (everything but the generated id), overridable per test.
function entityInput(overrides: Partial<EntityInput> = {}): EntityInput {
  return {
    type: 'Fact',
    label: 'Test entity',
    properties: {},
    valid_from: '2026-06-22T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
    ...overrides,
  };
}

// An ISO string `days` ago, for stale-candidate fixtures.
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('lib/graph-compact — prunePendingEntities', () => {
  it('AC-8: a stale unconfirmed candidate is marked pruned and drops out of searchEntities', () => {
    // Matches the prune criteria: unconfirmed, 31 days old, confidence 0.7, no relations, active.
    const stale = appendEntity(
      entityInput({
        label: 'stale candidate',
        confirmed: false,
        confidence: 0.7,
        valid_from: daysAgoIso(31),
      }),
    );

    prunePendingEntities();

    // A SupersessionPatch with new:'pruned' for the stale id was appended.
    const lines = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const prunedPatch = lines.find(
      (r) => r.op === 'supersede' && r.old === stale.id && r.new === 'pruned',
    );
    expect(prunedPatch).toBeDefined();

    // The pruned entity is absent from active results (superseded_by !== null filters it out).
    expect(searchEntities('').map((e) => e.id)).not.toContain(stale.id);
  });

  it('EC-6: running twice appends only one pruned patch (superseded_by===null guard)', () => {
    appendEntity(
      entityInput({
        label: 'stale once',
        confirmed: false,
        confidence: 0.7,
        valid_from: daysAgoIso(31),
      }),
    );

    prunePendingEntities();
    prunePendingEntities();

    const prunedPatches = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.op === 'supersede' && r.new === 'pruned');
    expect(prunedPatches).toHaveLength(1);
  });

  it('EC-10: null / malformed valid_from is skipped — no throw, not pruned', () => {
    const nullDate = appendEntity(
      entityInput({
        label: 'null date',
        confirmed: false,
        confidence: 0.7,
        // valid_from is typed string, but the EC-10 path must survive a non-date value at runtime.
        valid_from: null as unknown as string,
      }),
    );
    const badDate = appendEntity(
      entityInput({
        label: 'bad date',
        confirmed: false,
        confidence: 0.7,
        valid_from: 'not-a-date',
      }),
    );

    expect(() => prunePendingEntities()).not.toThrow();

    // Neither was pruned: no supersede patch for either id; both still active.
    const lines = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const prunedIds = lines
      .filter((r) => r.op === 'supersede' && r.new === 'pruned')
      .map((r) => r.old);
    expect(prunedIds).not.toContain(nullDate.id);
    expect(prunedIds).not.toContain(badDate.id);
  });

  it('does not prune entities that fail a single criterion (confirmed / fresh / high-conf / has-relations)', () => {
    const confirmed = appendEntity(
      entityInput({ label: 'confirmed', confirmed: true, confidence: 0.7, valid_from: daysAgoIso(31) }),
    );
    const fresh = appendEntity(
      entityInput({ label: 'fresh', confirmed: false, confidence: 0.7, valid_from: daysAgoIso(1) }),
    );
    const highConf = appendEntity(
      entityInput({ label: 'high conf', confirmed: false, confidence: 0.95, valid_from: daysAgoIso(31) }),
    );
    // Phase 3: outgoing relations now live ONLY as relate patches (W3 wholesale-clear drops any
    // inline properties.relations with no backing patch). So the "has-relations" protection comes
    // from a real relate patch — attachRelations surfaces it, and the prune guard spares the entity.
    const related = appendEntity(
      entityInput({
        label: 'has relations',
        confirmed: false,
        confidence: 0.7,
        valid_from: daysAgoIso(31),
      }),
    );
    const relatedTarget = appendEntity(entityInput({ label: 'relation target' }));
    appendRelate(related.id, 'works_on', relatedTarget.id, 0.7, 'session:s1', false);

    prunePendingEntities();

    const prunedIds = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.op === 'supersede' && r.new === 'pruned')
      .map((r) => r.old);
    expect(prunedIds).not.toContain(confirmed.id);
    expect(prunedIds).not.toContain(fresh.id);
    expect(prunedIds).not.toContain(highConf.id);
    expect(prunedIds).not.toContain(related.id);
  });
});

describe('lib/graph-compact — compactGraph', () => {
  it('AC-9: compacting a nonexistent path returns without throwing', async () => {
    await expect(compactGraph('/nonexistent/path/graph.jsonl')).resolves.toBeUndefined();
  });

  it('EC-3 round-trip: a graph with 2 active + 1 superseded compacts to 2 survivors', async () => {
    const a = appendEntity(entityInput({ label: 'active A' }));
    const b = appendEntity(entityInput({ label: 'active B' }));
    const old = appendEntity(entityInput({ label: 'old' }));
    const replacement = appendEntity(entityInput({ label: 'replacement' }));
    appendSupersede(old.id, replacement.id); // old is now superseded → dropped on compact

    await compactGraph(graphFile);

    const survivors = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const ids = survivors.map((e) => e.id);
    // 3 active survivors (a, b, replacement); old is dropped. No patch lines remain.
    expect(survivors).toHaveLength(3);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(replacement.id);
    expect(ids).not.toContain(old.id);
    expect(survivors.every((r) => r.op === undefined)).toBe(true);
  });

  it('EC-9: a clean run leaves no .compact.tmp artifact and the file is intact', async () => {
    appendEntity(entityInput({ label: 'one' }));
    appendEntity(entityInput({ label: 'two' }));

    await compactGraph(graphFile);

    expect(fs.existsSync(graphFile)).toBe(true);
    expect(fs.existsSync(graphFile + '.compact.tmp')).toBe(false);
    // Survivors are well-formed and the file is non-empty.
    const survivors = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(survivors).toHaveLength(2);
  });

  it('drops a pruned entity on compact (pruned === superseded_by !== null)', async () => {
    const keep = appendEntity(entityInput({ label: 'keep' }));
    const drop = appendEntity(
      entityInput({ label: 'to prune', confirmed: false, confidence: 0.7, valid_from: daysAgoIso(31) }),
    );
    prunePendingEntities(); // appends a pruned supersede patch for `drop`

    await compactGraph(graphFile);

    const ids = fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .map((e) => e.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });
});

describe('lib/graph-compact — graphEntitySources (GAP #2)', () => {
  it('returns ALL entity sources status-agnostically (active + superseded + pruned)', () => {
    // Active entity.
    appendEntity(entityInput({ label: 'active', source: 'session:active-1' }));

    // Superseded entity: append the entity, then a real supersede patch pointing at a replacement.
    const old = appendEntity(entityInput({ label: 'old', source: 'session:superseded-1' }));
    const replacement = appendEntity(entityInput({ label: 'new', source: 'session:replacement-1' }));
    appendSupersede(old.id, replacement.id);

    // Pruned entity: append a stale candidate, then prune it (writes a new:'pruned' patch).
    appendEntity(
      entityInput({
        label: 'pruned',
        source: 'session:pruned-1',
        confirmed: false,
        confidence: 0.7,
        valid_from: daysAgoIso(31),
      }),
    );
    prunePendingEntities();

    const sources = graphEntitySources(graphFile);
    // All three statuses contribute — none omitted (this fails loudly if the read drifts active-only).
    expect(sources.has('session:active-1')).toBe(true);
    expect(sources.has('session:superseded-1')).toBe(true);
    expect(sources.has('session:replacement-1')).toBe(true);
    expect(sources.has('session:pruned-1')).toBe(true);
  });

  it('returns an empty set for a nonexistent graph file', () => {
    expect(graphEntitySources('/nonexistent/path/graph.jsonl').size).toBe(0);
  });

  it('skips patch lines (supersede/confirm carry no source)', () => {
    const old = appendEntity(entityInput({ label: 'old', source: 'session:only-1' }));
    const replacement = appendEntity(entityInput({ label: 'new', source: 'session:only-2' }));
    appendSupersede(old.id, replacement.id); // a patch line — must not appear as a source

    const sources = graphEntitySources(graphFile);
    expect([...sources].sort()).toEqual(['session:only-1', 'session:only-2']);
  });
});

// ── Track 6 Phase 3 — edge-aware compaction + prune-guard ──────────────────────────────────────
// foldRecords now folds the (from, rel, to) edge patches (via the shared resolveEdges/attachRelations
// from lib/graph), and compactGraph re-emits the resolved LIVE edges as relate lines. These tests
// pin: prunePendingEntities spares an entity whose only outgoing edge is a relate patch (FR14/AC-11);
// compactGraph drops expired + orphaned-from edges and keeps live confirmed ones (AC-10/EC6); and the
// post-compaction confirmed edge survives a later automated relate (blocker path b / AC-15).
describe('lib/graph-compact — Track 6 Phase 3 edge fold', () => {
  // Read the compacted/live JSONL back as raw records (entity lines + edge lines).
  function readLines(): Array<Record<string, unknown>> {
    return fs
      .readFileSync(graphFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('AC-10: compactGraph drops expired + orphaned edges, keeps the live confirmed edge as a relate line', async () => {
    const a = appendEntity(entityInput({ label: 'A' }));
    const b = appendEntity(entityInput({ label: 'B' }));
    const c = appendEntity(entityInput({ label: 'C' }));

    // Live confirmed edge A → B.
    appendRelate(a.id, 'child_of', b.id, 1.0, 'manual', true);
    // Expired edge A → C: a relate then an unrelate collapses to valid_until !== null.
    appendRelate(a.id, 'works_on', c.id, 0.9, 'session:s1', false);
    appendUnrelate(a.id, 'works_on', c.id);

    await compactGraph(graphFile);

    const lines = readLines();
    const edgeLines = lines.filter((r) => r.op === 'relate');
    // Exactly one edge line survives: the live confirmed A → B.
    expect(edgeLines).toHaveLength(1);
    expect(edgeLines[0]).toMatchObject({
      op: 'relate',
      from: a.id,
      rel: 'child_of',
      to: b.id,
      confirmed: true,
      valid_until: null,
    });
    // The expired A → C edge is absent, and no confirm_relate / unrelate lines are re-emitted.
    expect(lines.some((r) => r.op === 'unrelate')).toBe(false);
    expect(lines.some((r) => r.op === 'confirm_relate')).toBe(false);
    expect(edgeLines.some((r) => r.to === c.id)).toBe(false);
  });

  it('AC-11: prunePendingEntities spares an unconfirmed, stale entity that has an outgoing relate patch', () => {
    // A stale unconfirmed candidate that WOULD be pruned if it had no relations…
    const candidate = appendEntity(
      entityInput({
        label: 'candidate with edge',
        confirmed: false,
        confidence: 0.7,
        valid_from: daysAgoIso(31),
      }),
    );
    const target = appendEntity(entityInput({ label: 'edge target' }));
    // …but it has an outgoing relate patch (unconfirmed). attachRelations now surfaces this as an
    // entry in properties.relations, so the prune guard at graph-compact.ts:176 spares it.
    appendRelate(candidate.id, 'works_on', target.id, 0.7, 'session:s1', false);

    prunePendingEntities();

    // No 'pruned' supersede patch was appended for the candidate.
    const prunedIds = readLines()
      .filter((r) => r.op === 'supersede' && r.new === 'pruned')
      .map((r) => r.old as string);
    expect(prunedIds).not.toContain(candidate.id);
  });

  it('EC6: an edge whose `from` did not survive compaction is dropped and the compact re-loads clean', async () => {
    const keep = appendEntity(entityInput({ label: 'keep' }));
    const gone = appendEntity(entityInput({ label: 'gone' }));
    const replacement = appendEntity(entityInput({ label: 'replacement' }));
    // Confirmed edge FROM the entity that is about to be superseded.
    appendRelate(gone.id, 'points_to', keep.id, 1.0, 'manual', true);
    appendSupersede(gone.id, replacement.id); // `gone` will not survive compaction

    await compactGraph(graphFile);

    const lines = readLines();
    // No relate line for the dropped `from`.
    expect(lines.some((r) => r.op === 'relate' && r.from === gone.id)).toBe(false);
    // Re-loading the compacted file does not throw and the survivors are intact.
    expect(() => loadGraph()).not.toThrow();
    const ids = loadGraph().map((e) => e.id);
    expect(ids).toContain(keep.id);
    expect(ids).toContain(replacement.id);
    expect(ids).not.toContain(gone.id);
  });

  it('blocker path (b) / AC-15: a compacted confirmed edge is NOT downgraded by a later automated relate', async () => {
    const parent = appendEntity(entityInput({ label: 'parent' }));
    const child = appendEntity(entityInput({ label: 'child' }));

    // 2–3: unconfirmed relate, then a human confirm_relate.
    appendRelate(child.id, 'child_of', parent.id, 0.8, 'session:s1', false);
    appendConfirmRelate(child.id, 'child_of', parent.id);

    // 4: compact — the confirm_relate collapses into a relate(confirmed:true) line.
    await compactGraph(graphFile);
    const edgeLines = readLines().filter((r) => r.op === 'relate');
    expect(edgeLines).toHaveLength(1);
    expect(edgeLines[0]).toMatchObject({ confirmed: true, valid_until: null });

    // 5: a later automated (confirmed:false) relate for the same triple, appended to the compact.
    appendRelate(child.id, 'child_of', parent.id, 0.6, 'session:s2', false);

    // 6: loadGraph re-applies the one-way latch — the edge stays confirmed and BFS still follows it.
    const folded = loadGraph();
    const childRec = folded.find((e) => e.id === child.id)!;
    const rel = (childRec.properties.relations ?? []).find((r) => r.target_id === parent.id);
    expect(rel).toBeDefined();
    expect(rel!.confirmed).toBe(true);
    expect(relatedEntities(child.id).map((e) => e.id)).toContain(parent.id);
  });
});
