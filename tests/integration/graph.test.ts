import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Type-only import (erased at runtime — no effect on the MOT_GRAPH_PATH lazy-env ordering).
import type { RelatePatch } from '../../lib/graph';

// Recallatron Phase 2 — the entity graph (FR 6–11, EC-1/3/5/6/9, AC-4/5/6/13).
// lib/graph reads MOT_GRAPH_PATH lazily on every call (same lazy-env pattern as DATABASE_URL),
// so each test points it at a fresh temp file. NEVER writes to the real ontology/ directory.
// MOT_GRAPH_PATH is set before the first dynamic import of lib/graph.

let tmpDir: string;
let graphFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-graph-'));
  graphFile = path.join(tmpDir, 'graph.jsonl');
  process.env.MOT_GRAPH_PATH = graphFile;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// Lazily resolved at call time (env is set in beforeEach above).
const {
  appendEntity,
  appendSupersede,
  appendEntityConfirm,
  appendRelate,
  appendConfirmRelate,
  appendUnrelate,
  resolveEdges,
  resolveEdge,
  confirmRelate,
  rejectRelate,
  getEntity,
  searchEntities,
  relatedEntities,
  REL_VOCABULARY,
  isRelType,
} = await import('../../lib/graph');

// A minimal valid entity record (everything but the generated id), overridable per test.
function entityInput(
  overrides: Partial<Parameters<typeof appendEntity>[0]> = {},
): Parameters<typeof appendEntity>[0] {
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

describe('Recallatron Phase 2 — entity graph (lib/graph)', () => {
  it('append + read round-trip: two entities both present', () => {
    const a = appendEntity(entityInput({ label: 'Alice' }));
    const b = appendEntity(entityInput({ label: 'Bob' }));

    // Read back via searchEntities (loadGraph is internal) with an empty query → matches all.
    const all = searchEntities('');
    const ids = all.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(all).toHaveLength(2);
  });

  it('append uses a single appendFileSync (one line per record, file ends with newline)', () => {
    appendEntity(entityInput({ label: 'One' }));
    appendEntity(entityInput({ label: 'Two' }));
    const raw = fs.readFileSync(graphFile, 'utf8');
    // Two records → two newline-terminated lines, no temp-rename artifacts.
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2);
  });

  it('lazily creates the ontology dir on first append (no SQL migration)', () => {
    // graphFile lives under a not-yet-created nested dir.
    const nested = path.join(tmpDir, 'ontology', 'graph.jsonl');
    process.env.MOT_GRAPH_PATH = nested;
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    appendEntity(entityInput());
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('supersession patch fold: A.superseded_by becomes B (getEntity reflects it)', () => {
    const a = appendEntity(entityInput({ label: 'Old fact' }));
    const b = appendEntity(entityInput({ label: 'New fact' }));
    appendSupersede(a.id, b.id);

    const got = getEntity(a.id);
    expect(got).not.toBeNull();
    expect(got!.record.superseded_by).toBe(b.id);
  });

  it('confirm fold: false → true; an unpatched false entity stays false (FR-1)', () => {
    // Seed both entities explicitly confirmed:false so a true result is the fold, not the seed.
    const confirmed = appendEntity(entityInput({ label: 'to confirm', confirmed: false }));
    const untouched = appendEntity(entityInput({ label: 'left alone', confirmed: false }));

    appendEntityConfirm(confirmed.id);

    const got = getEntity(confirmed.id);
    expect(got).not.toBeNull();
    expect(got!.record.confirmed).toBe(true);

    // The entity that received no confirm patch must still read back false — proves the fold
    // (not the seed) is what flipped the first one.
    const other = getEntity(untouched.id);
    expect(other!.record.confirmed).toBe(false);
  });

  it('appendEntityConfirm round-trip: writes a {op:confirm,id,ts} line; entity reads confirmed', () => {
    const e = appendEntity(entityInput({ label: 'pending', confirmed: false }));
    appendEntityConfirm(e.id);

    // Parse the last JSONL line directly from the temp file.
    const lines = fs.readFileSync(graphFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.op).toBe('confirm');
    expect(last.id).toBe(e.id);
    expect(typeof last.ts).toBe('string');

    // And the entity reloaded through the public reader reflects the confirmation.
    const got = getEntity(e.id);
    expect(got!.record.confirmed).toBe(true);
  });

  it('confirm-patch branch does not swallow plain entity lines (regression guard)', () => {
    // Write a plain entity record (no `op` field) directly to the temp file. The new confirm
    // discrimination branch must still load it as an entity, not skip or mis-route it.
    const rec = {
      id: 'manual-entity-1',
      type: 'Fact',
      label: 'hand-written entity',
      properties: {},
      valid_from: '2026-06-22T00:00:00.000Z',
      valid_until: null,
      confidence: 0.9,
      source: 'manual',
      superseded_by: null,
      confirmed: true,
    };
    fs.appendFileSync(graphFile, JSON.stringify(rec) + '\n');

    // searchEntities drives loadGraph; the entity must come back.
    const ids = searchEntities('').map((e) => e.id);
    expect(ids).toContain('manual-entity-1');
  });

  it('malformed line is skipped, not thrown (EC-1, AC-13)', () => {
    const good = appendEntity(entityInput({ label: 'Valid' }));
    // Manually append a bad JSON line directly to the file.
    fs.appendFileSync(graphFile, 'this is not json{{{\n');
    const another = appendEntity(entityInput({ label: 'Also valid' }));

    // Indirectly drives loadGraph; must not throw and must return the valid entities.
    // Annotate via a non-overloaded EntityRecord[]-returning fn: searchEntities gained a
    // sync|async overload pair (Track 5), so ReturnType<typeof searchEntities> now resolves
    // to the async (last) overload. relatedEntities returns the same element type, sync.
    let results: ReturnType<typeof relatedEntities> = [];
    expect(() => {
      results = searchEntities('');
    }).not.toThrow();

    const ids = results.map((e) => e.id);
    expect(ids).toContain(good.id);
    expect(ids).toContain(another.id);
    expect(results).toHaveLength(2);
  });

  it('cycle traversal A↔B does not loop; the visited guard blocks revisiting A (EC-3)', () => {
    // 2-node cycle A ⇄ B. Track 6: edges live as relate patches (confirmed:true), not inline on
    // the record, so append both entities first then wire the edges both ways.
    const a = appendEntity(entityInput({ label: 'A' }));
    const b = appendEntity(entityInput({ label: 'B' }));
    appendRelate(a.id, 'knows', b.id, 0.9, 'manual', true);
    appendRelate(b.id, 'knows', a.id, 0.9, 'manual', true);

    let related: ReturnType<typeof relatedEntities> = [];
    expect(() => {
      related = relatedEntities(a.id, undefined, 2);
    }).not.toThrow();

    // The cycle guard must prevent revisiting the start node.
    expect(related.map((e) => e.id)).not.toContain(a.id);
    // B is reachable in one hop.
    expect(related.map((e) => e.id)).toContain(b.id);
  });

  it('caps the result set at 50 entities (AC-6)', () => {
    const root = appendEntity(entityInput({ label: 'root' }));
    for (let i = 0; i < 60; i++) {
      const leaf = appendEntity(entityInput({ label: `leaf-${i}`, confidence: 0.5 }));
      appendRelate(root.id, 'has', leaf.id, 0.9, 'manual', true);
    }

    const related = relatedEntities(root.id, undefined, 1);
    expect(related).toHaveLength(50);
  });

  it('searchEntities unconfirmedOnly returns only unconfirmed, non-superseded records (AC-5)', () => {
    const unconfirmed = appendEntity(entityInput({ label: 'pending', confirmed: false }));
    appendEntity(entityInput({ label: 'settled', confirmed: true }));
    // A superseded unconfirmed record must be excluded even under unconfirmedOnly.
    const supA = appendEntity(entityInput({ label: 'old-pending', confirmed: false }));
    const supB = appendEntity(entityInput({ label: 'replacement', confirmed: false }));
    appendSupersede(supA.id, supB.id);

    const results = searchEntities('', undefined, true);
    const ids = results.map((e) => e.id);
    expect(ids).toContain(unconfirmed.id);
    expect(ids).toContain(supB.id); // replacement is unconfirmed + not superseded
    expect(ids).not.toContain(supA.id); // superseded → excluded
    // The confirmed 'settled' record is excluded by the confirmed===false filter.
    expect(results.every((e) => e.confirmed === false && e.superseded_by === null)).toBe(true);
  });

  it('searchEntities default returns only active records (superseded/expired excluded, AC-5)', () => {
    const active = appendEntity(entityInput({ label: 'active note' }));
    const expired = appendEntity(
      entityInput({ label: 'expired note', valid_until: '2026-01-01T00:00:00.000Z' }),
    );
    const old = appendEntity(entityInput({ label: 'superseded note' }));
    const fresh = appendEntity(entityInput({ label: 'fresh note' }));
    appendSupersede(old.id, fresh.id);

    const results = searchEntities('note');
    const ids = results.map((e) => e.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(expired.id); // valid_until set → not active
    expect(ids).not.toContain(old.id); // superseded → not active
  });

  it('searchEntities matches on serialized properties, case-insensitively', () => {
    const e = appendEntity(
      entityInput({ label: 'Plain', properties: { nickname: 'Sparky' } }),
    );
    const hit = searchEntities('sparky');
    expect(hit.map((r) => r.id)).toContain(e.id);
  });

  it('searchEntities filters by type', () => {
    const person = appendEntity(entityInput({ type: 'Person', label: 'shared' }));
    appendEntity(entityInput({ type: 'Project', label: 'shared' }));
    const results = searchEntities('shared', 'Person');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(person.id);
  });

  it('getEntity returns outbound and inbound 1-hop neighbours (OQ-4)', () => {
    const target = appendEntity(entityInput({ label: 'target' }));
    const subject = appendEntity(entityInput({ label: 'subject' }));
    appendRelate(subject.id, 'mentions', target.id, 0.9, 'manual', true);

    const fromSubject = getEntity(subject.id);
    expect(fromSubject!.relations.outbound.map((e) => e.id)).toContain(target.id);
    expect(fromSubject!.relations.inbound).toHaveLength(0);

    const fromTarget = getEntity(target.id);
    expect(fromTarget!.relations.inbound.map((e) => e.id)).toContain(subject.id);
    expect(fromTarget!.relations.outbound).toHaveLength(0);
  });

  it('getEntity returns null for an unknown id', () => {
    appendEntity(entityInput());
    expect(getEntity('does-not-exist')).toBeNull();
  });

  it('relatedEntities returns [] for an unknown id', () => {
    appendEntity(entityInput());
    expect(relatedEntities('nope')).toEqual([]);
  });

  it('relatedEntities follows only the matching rel when one is given', () => {
    const friend = appendEntity(entityInput({ label: 'friend' }));
    const project = appendEntity(entityInput({ label: 'project' }));
    const root = appendEntity(entityInput({ label: 'root' }));
    appendRelate(root.id, 'knows', friend.id, 0.9, 'manual', true);
    appendRelate(root.id, 'owns', project.id, 0.9, 'manual', true);

    const knows = relatedEntities(root.id, 'knows', 1);
    expect(knows.map((e) => e.id)).toEqual([friend.id]);
  });

  it('relatedEntities clamps hops to 3 (EC-3)', () => {
    // Chain of 5 nodes: n0 → n1 → n2 → n3 → n4 wired via confirmed relate patches (Track 6).
    // With hops=10 (clamped to 3) we reach n1..n3.
    const n4 = appendEntity(entityInput({ label: 'n4' }));
    const n3 = appendEntity(entityInput({ label: 'n3' }));
    const n2 = appendEntity(entityInput({ label: 'n2' }));
    const n1 = appendEntity(entityInput({ label: 'n1' }));
    const n0 = appendEntity(entityInput({ label: 'n0' }));
    appendRelate(n3.id, 'next', n4.id, 0.9, 'manual', true);
    appendRelate(n2.id, 'next', n3.id, 0.9, 'manual', true);
    appendRelate(n1.id, 'next', n2.id, 0.9, 'manual', true);
    appendRelate(n0.id, 'next', n1.id, 0.9, 'manual', true);

    const related = relatedEntities(n0.id, undefined, 10);
    const reached = related.map((e) => e.id);
    expect(reached).toContain(n1.id);
    expect(reached).toContain(n2.id);
    expect(reached).toContain(n3.id);
    expect(reached).not.toContain(n4.id); // 4 hops away, beyond the clamp of 3
  });
});

describe('Track 6 — edge core (lib/graph)', () => {
  // Raw JSONL append — for fold fixtures that need explicit, ordered `ts` values (the append*
  // helpers stamp nowIso(), which can collide within a test). graphFile is set per-test above.
  function appendRaw(obj: unknown): void {
    fs.appendFileSync(graphFile, JSON.stringify(obj) + '\n');
  }
  // A relate patch line with an explicit ts (bypasses nowIso() for ordering).
  function relateLine(from: string, rel: string, to: string, confirmed: boolean, ts: string) {
    return {
      op: 'relate', from, rel, to, confidence: 0.9,
      source: confirmed ? 'manual' : 'session:s',
      valid_from: ts, valid_until: null, confirmed, ts,
    };
  }
  // Two real seeded entities (so relatedEntities can resolve the target by id).
  function seedPair(): { from: string; to: string } {
    const from = appendEntity(entityInput({ label: 'from-node' }));
    const to = appendEntity(entityInput({ label: 'to-node' }));
    return { from: from.id, to: to.id };
  }
  const relationsOf = (id: string) => getEntity(id)!.record.properties.relations ?? [];

  it('AC-1: appendRelate writes a round-trippable relate line with all required fields', () => {
    const { from, to } = seedPair();
    const patch = appendRelate(from, 'child_of', to, 0.9, 'session:s1', false);
    const lines = fs.readFileSync(graphFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.op).toBe('relate');
    for (const k of ['from', 'rel', 'to', 'confidence', 'source', 'valid_from', 'valid_until', 'confirmed', 'ts']) {
      expect(parsed).toHaveProperty(k);
    }
    expect(patch.valid_until).toBeNull(); // expiry is only ever expressed by an unrelate op
    expect(patch.from).toBe(from);
  });

  it('AC-2: loadGraph fold populates properties.relations from a confirmed relate', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'manual', true);
    expect(relationsOf(from)).toContainEqual({ rel: 'child_of', target_id: to, confirmed: true });
  });

  it('AC-3: relatedEntities is non-empty for a confirmed edge, [] when the only edge is confirmed:false', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'manual', true);
    expect(relatedEntities(from).map((e) => e.id)).toContain(to);

    const only = seedPair();
    appendRelate(only.from, 'child_of', only.to, 0.9, 'session:s', false);
    expect(relatedEntities(only.from)).toEqual([]);
  });

  it('AC-4: a manual confirmed edge is reflected in relatedEntities', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 1.0, 'manual', true);
    expect(relatedEntities(from).map((e) => e.id)).toContain(to);
  });

  it('EC4: a duplicate relate triple folds to exactly one relations entry', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'manual', true);
    appendRelate(from, 'child_of', to, 0.95, 'manual', true);
    const hits = relationsOf(from).filter((r) => r.rel === 'child_of' && r.target_id === to);
    expect(hits).toHaveLength(1);
  });

  it('EC7: an unrelated (expired) edge is absent from relations and from the BFS', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'manual', true);
    appendUnrelate(from, 'child_of', to);
    expect(relationsOf(from).some((r) => r.target_id === to)).toBe(false);
    expect(relatedEntities(from)).toEqual([]);
  });

  it('vocabulary closure: every REL_VOCABULARY verb passes isRelType; off-vocab fails', () => {
    REL_VOCABULARY.forEach((v) => expect(isRelType(v)).toBe(true));
    ['is_parent_of', 'runs_on', 'needs', ''].forEach((v) => expect(isRelType(v)).toBe(false));
  });

  it('(a) AC-14: confirmed one-way latch survives a later automated relate(confirmed:false)', () => {
    const { from, to } = seedPair();
    appendRaw(relateLine(from, 'child_of', to, true, '2026-01-01T00:00:00.000Z'));
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-02T00:00:00.000Z'));
    expect(relationsOf(from)).toContainEqual({ rel: 'child_of', target_id: to, confirmed: true });
    expect(relatedEntities(from).map((e) => e.id)).toContain(to);
  });

  it('(c) AC-17: expired stays expired, then a manual re-assert restores it live + confirmed', () => {
    const { from, to } = seedPair();
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-01T00:00:00.000Z'));
    appendRaw({ op: 'unrelate', from, rel: 'child_of', to, ts: '2026-01-02T00:00:00.000Z' });
    expect(relationsOf(from).some((r) => r.target_id === to)).toBe(false);
    expect(relatedEntities(from)).toEqual([]);
    // Manual re-assert at a later ts.
    appendRaw(relateLine(from, 'child_of', to, true, '2026-01-03T00:00:00.000Z'));
    expect(relationsOf(from)).toContainEqual({ rel: 'child_of', target_id: to, confirmed: true });
    expect(relatedEntities(from).map((e) => e.id)).toContain(to);
  });

  it('AC-16: an automated relate does NOT un-expire a human-rejected edge', () => {
    const { from, to } = seedPair();
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-01T00:00:00.000Z'));
    appendRaw({ op: 'unrelate', from, rel: 'child_of', to, ts: '2026-01-02T00:00:00.000Z' });
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-03T00:00:00.000Z')); // ts3 > ts2
    expect(relationsOf(from).some((r) => r.target_id === to)).toBe(false);
    expect(relatedEntities(from)).toEqual([]);
  });

  it('confirm-then-downgrade: confirm_relate latches confirmed through a later automated relate', () => {
    const { from, to } = seedPair();
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-01T00:00:00.000Z'));
    appendRaw({ op: 'confirm_relate', from, rel: 'child_of', to, ts: '2026-01-02T00:00:00.000Z' });
    appendRaw(relateLine(from, 'child_of', to, false, '2026-01-03T00:00:00.000Z'));
    expect(resolveEdge(from, 'child_of', to)?.confirmed).toBe(true);
  });

  it('W3: an inline old-shape relations array with no relate patch is cleared to []', () => {
    appendRaw({
      id: 'w3-entity', type: 'Fact', label: 'phantom holder',
      properties: { relations: [{ rel: 'x', target_id: 'y' }] },
      valid_from: '2026-06-22T00:00:00.000Z', valid_until: null, confidence: 0.9,
      source: 'manual', superseded_by: null, confirmed: true,
    });
    expect(getEntity('w3-entity')!.record.properties.relations).toEqual([]);
  });

  it('W4 (AC-18): rejectRelate — reject a live edge, then typed errors, never throws', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'session:s', false); // live unconfirmed edge
    const rejected = rejectRelate(from, 'child_of', to);
    expect('error' in rejected).toBe(false);
    expect((rejected as RelatePatch).valid_until).not.toBeNull();
    expect(relationsOf(from).some((r) => r.target_id === to)).toBe(false);
    expect(relatedEntities(from)).toEqual([]);
    // No relate patch for the triple → not_found.
    expect(rejectRelate(from, 'child_of', 'no-such-target')).toEqual({ error: 'not_found' });
    // Already expired → already_rejected.
    expect(rejectRelate(from, 'child_of', to)).toEqual({ error: 'already_rejected' });
  });

  it('confirmRelate — confirm a candidate, then typed errors, never throws', () => {
    const { from, to } = seedPair();
    appendRelate(from, 'child_of', to, 0.9, 'session:s', false); // unconfirmed candidate
    const confirmed = confirmRelate(from, 'child_of', to);
    expect('error' in confirmed).toBe(false);
    expect((confirmed as RelatePatch).confirmed).toBe(true);
    expect(relatedEntities(from).map((e) => e.id)).toContain(to);
    expect(confirmRelate(from, 'child_of', to)).toEqual({ error: 'already_confirmed' });
    expect(confirmRelate(from, 'child_of', 'no-such-target')).toEqual({ error: 'not_found' });
  });

  it('resolveEdges drops a triple that has no base relate (confirm/unrelate only)', () => {
    const resolved = resolveEdges(
      [],
      [{ op: 'confirm_relate', from: 'a', rel: 'child_of', to: 'b', ts: '2026-01-01T00:00:00.000Z' }],
      [{ op: 'unrelate', from: 'a', rel: 'child_of', to: 'b', ts: '2026-01-02T00:00:00.000Z' }],
    );
    expect(resolved).toEqual([]);
  });
});
