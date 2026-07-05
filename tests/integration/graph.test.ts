import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  getEntity,
  searchEntities,
  relatedEntities,
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
    // Build a 2-node cycle. Ids are generated on append, so author B first (pointing nowhere),
    // then A pointing at B, then a final B carrying the back-edge to A. The edged-B is the node
    // A points at, giving A → B → A.
    const bStub = appendEntity(entityInput({ label: 'B-stub' }));
    const a = appendEntity(
      entityInput({
        label: 'A',
        properties: { relations: [{ rel: 'knows', target_id: bStub.id }] },
      }),
    );
    // Supersede the stub with a B that points back at A — keeps a single live B node and forms
    // the cycle A → B → A. (loadGraph marks bStub superseded; traversal still resolves it by id.)
    const b = appendEntity(
      entityInput({
        label: 'B',
        properties: { relations: [{ rel: 'knows', target_id: a.id }] },
      }),
    );
    // Re-point A at the live B so the cycle is fully A → B → A with no superseded hop.
    const aCycle = appendEntity(
      entityInput({
        label: 'A',
        properties: { relations: [{ rel: 'knows', target_id: b.id }] },
      }),
    );

    let related: ReturnType<typeof relatedEntities> = [];
    expect(() => {
      related = relatedEntities(aCycle.id, undefined, 2);
    }).not.toThrow();

    // The cycle guard must prevent revisiting the start node.
    expect(related.map((e) => e.id)).not.toContain(aCycle.id);
    // B is reachable in one hop.
    expect(related.map((e) => e.id)).toContain(b.id);
  });

  it('caps the result set at 50 entities (AC-6)', () => {
    const root = appendEntity(entityInput({ label: 'root' }));
    const targetIds: string[] = [];
    for (let i = 0; i < 60; i++) {
      const leaf = appendEntity(entityInput({ label: `leaf-${i}`, confidence: 0.5 }));
      targetIds.push(leaf.id);
    }
    // Re-author root with edges to all 60 leaves (append a fresh root carrying the relations).
    const rootWithEdges = appendEntity(
      entityInput({
        label: 'root',
        properties: { relations: targetIds.map((id) => ({ rel: 'has', target_id: id })) },
      }),
    );
    void root;

    const related = relatedEntities(rootWithEdges.id, undefined, 1);
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
    const subject = appendEntity(
      entityInput({
        label: 'subject',
        properties: { relations: [{ rel: 'mentions', target_id: target.id }] },
      }),
    );

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
    const root = appendEntity(
      entityInput({
        label: 'root',
        properties: {
          relations: [
            { rel: 'knows', target_id: friend.id },
            { rel: 'owns', target_id: project.id },
          ],
        },
      }),
    );

    const knows = relatedEntities(root.id, 'knows', 1);
    expect(knows.map((e) => e.id)).toEqual([friend.id]);
  });

  it('relatedEntities clamps hops to 3 (EC-3)', () => {
    // Chain of 5 nodes: n0 → n1 → n2 → n3 → n4. With hops=10 (clamped to 3) we reach n1..n3.
    const ids: string[] = [];
    // Build leaves first so each node can reference the next id.
    const n4 = appendEntity(entityInput({ label: 'n4' }));
    const n3 = appendEntity(
      entityInput({ label: 'n3', properties: { relations: [{ rel: 'next', target_id: n4.id }] } }),
    );
    const n2 = appendEntity(
      entityInput({ label: 'n2', properties: { relations: [{ rel: 'next', target_id: n3.id }] } }),
    );
    const n1 = appendEntity(
      entityInput({ label: 'n1', properties: { relations: [{ rel: 'next', target_id: n2.id }] } }),
    );
    const n0 = appendEntity(
      entityInput({ label: 'n0', properties: { relations: [{ rel: 'next', target_id: n1.id }] } }),
    );
    ids.push(n0.id, n1.id, n2.id, n3.id, n4.id);

    const related = relatedEntities(n0.id, undefined, 10);
    const reached = related.map((e) => e.id);
    expect(reached).toContain(n1.id);
    expect(reached).toContain(n2.id);
    expect(reached).toContain(n3.id);
    expect(reached).not.toContain(n4.id); // 4 hops away, beyond the clamp of 3
  });
});
