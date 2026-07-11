import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 9 Phase 2 — the resolution worker (lib/maintainer.ts, Worker 1). Harness mirrors
// extraction.test.ts: MOT_EMBED_DISABLE=1 (already set suite-wide by vitest.config) and MOT_GRAPH_PATH
// pointed at a temp .jsonl file, BOTH before the first dynamic import (graphPath()/embedding read the
// env lazily on every call). resolutionWorker takes an injectable `identify` — every test passes a stub
// that returns canned identifications, so NO test ever spawns a real `claude -p`.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-maint-res-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

const { resolutionWorker } = await import('../../lib/maintainer');
const { appendEntity, loadGraph, relatedEntities, getEntity, searchEntities } = await import(
  '../../lib/graph'
);
type EntityRecord = import('../../lib/graph').EntityRecord;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// A fresh, isolated graph file per test so runs don't bleed into each other.
function resetGraph(): void {
  fs.mkdirSync(path.dirname(graphFile), { recursive: true });
  fs.writeFileSync(graphFile, '');
}

// Seed one descriptive Fact "sentence" (the shape the real graph is full of — no named node yet).
function seedFact(label: string): EntityRecord {
  return appendEntity({
    type: 'Fact',
    label,
    properties: {},
    confidence: 0.9,
    confirmed: false,
    source: 'session:seed',
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    superseded_by: null,
  });
}

function graphLineCount(): number {
  if (!fs.existsSync(graphFile)) return 0;
  return fs.readFileSync(graphFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

// Build the stub identification the LLM would return for a "Taylor" Person from N member Fact ids.
function robinIdentification(memberIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    identifications: [
      {
        canonical_label: 'Taylor',
        canonical_type: 'Person',
        existing_representative_id: null,
        member_entity_ids: memberIds,
        distinct_source_count: memberIds.length,
        confidence: 0.9,
        reason: 'test',
        ...overrides,
      },
    ],
  };
}

describe('Track 9 Phase 2 — resolution worker (lib/maintainer)', () => {
  it('AC-1 / FR-2 / FR-3 — mints the canonical node and links ≥5 descriptive Facts to it', () => {
    resetGraph();
    const facts = Array.from({ length: 5 }, (_, i) => seedFact(`Taylor fact ${i}: he does thing ${i}`));
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    const status = resolutionWorker({ dryRun: false, identify: stubIdentify });

    // The stub was consulted (never a real claude -p) and one node was minted.
    expect(stubIdentify).toHaveBeenCalledTimes(1);
    expect(status.named_nodes_minted).toBe(1);
    expect(status.edges_linked).toBe(5);

    const robin = searchEntities('Taylor', 'Person');
    expect(robin).toHaveLength(1);

    // AC-1 (literal): entity_related(Taylor) returns ≥5 neighbours. Edge direction is Fact→Taylor
    // (member points_to canonical, per the spec mapping + the closed vocabulary's subject→object
    // direction), so the Facts are INBOUND to Taylor. relatedEntities is now bidirectional (Phase 2b),
    // so traversing from Taylor follows those inbound edges and surfaces every member Fact.
    const relatedToTaylor = relatedEntities(robin[0].id).map((n) => n.id);
    expect(relatedToTaylor.length).toBeGreaterThanOrEqual(5);
    for (const f of facts) {
      expect(relatedToTaylor).toContain(f.id);
    }

    // The complements still hold: getEntity's inbound arm sees the ≥5 members, and each member
    // reaches Taylor via its outbound edge (relatedEntities in the other direction).
    const robinNode = getEntity(robin[0].id)!;
    expect(robinNode.relations.inbound.length).toBeGreaterThanOrEqual(5);
    for (const f of facts) {
      expect(relatedEntities(f.id).map((n) => n.id)).toContain(robin[0].id);
    }
  });

  it('AC-2 — the minted node is confirmed:false with source maintainer:resolution', () => {
    resetGraph();
    const facts = Array.from({ length: 3 }, (_, i) => seedFact(`Taylor fact ${i}`));
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    resolutionWorker({ dryRun: false, identify: stubIdentify });

    const robin = searchEntities('Taylor', 'Person');
    expect(robin).toHaveLength(1);
    expect(robin[0].confirmed).toBe(false);
    expect(robin[0].source).toBe('maintainer:resolution');
  });

  it('AC-5 / FR-19 / B3 — a second pass over the same state appends ZERO new lines', () => {
    resetGraph();
    const facts = Array.from({ length: 3 }, (_, i) => seedFact(`Taylor fact ${i}`));
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    resolutionWorker({ dryRun: false, identify: stubIdentify });
    const afterFirst = graphLineCount();

    // Same stub, same graph — the persisted-edge seeding must make every points_to already-seen.
    const status2 = resolutionWorker({ dryRun: false, identify: stubIdentify });

    expect(graphLineCount()).toBe(afterFirst);
    expect(status2.named_nodes_minted).toBe(0); // exact-label reuse, no re-mint
    expect(status2.edges_linked).toBe(0); // seenEdges seeded from disk → no re-append
  });

  it('B3 mechanism — the run-1 points_to edges are folded live in loadGraph() before run 2', () => {
    resetGraph();
    const facts = Array.from({ length: 3 }, (_, i) => seedFact(`Taylor fact ${i}`));
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    resolutionWorker({ dryRun: false, identify: stubIdentify });

    // The seeding reads the PERSISTED graph, not in-memory state: each Fact's folded
    // properties.relations[] carries the points_to it just got, keyed to the minted Taylor.
    const robin = searchEntities('Taylor', 'Person')[0];
    const active = loadGraph().filter((e) => e.superseded_by === null);
    for (const f of facts) {
      const rec = active.find((e) => e.id === f.id)!;
      expect(rec.properties.relations).toContainEqual(
        expect.objectContaining({ rel: 'points_to', target_id: robin.id }),
      );
    }
  });

  it('FR-5 — a below-threshold distinct_source_count is NOT minted', () => {
    resetGraph();
    const fact = seedFact('Taylor was mentioned once');
    // Person threshold is 2; a distinct_source_count of 1 with no existing representative → skip.
    const stubIdentify = vi.fn().mockReturnValue(
      robinIdentification([fact.id], { distinct_source_count: 1 }),
    );

    const before = graphLineCount();
    const status = resolutionWorker({ dryRun: false, identify: stubIdentify });

    expect(status.named_nodes_minted).toBe(0);
    expect(status.edges_linked).toBe(0);
    expect(graphLineCount()).toBe(before); // nothing appended at all
    expect(searchEntities('Taylor', 'Person')).toHaveLength(0);
  });

  it('AC-4 / FR-3 — every pre-existing entity survives active and unchanged (Facts untouched)', () => {
    resetGraph();
    const facts = Array.from({ length: 3 }, (_, i) => seedFact(`Taylor fact ${i}`));
    const before = loadGraph();
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    resolutionWorker({ dryRun: false, identify: stubIdentify });

    const afterById = new Map(loadGraph().map((e) => [e.id, e]));
    for (const e of before) {
      const after = afterById.get(e.id);
      expect(after).toBeDefined();
      expect(after!.superseded_by).toBeNull(); // no Fact superseded (FR-3/FR-17)
      expect(after!.label).toBe(e.label); // not rewritten
      expect(after!.type).toBe('Fact');
    }
  });

  it('FR-13 / AC-9 — dry_run runs identify but writes nothing', () => {
    resetGraph();
    const facts = Array.from({ length: 3 }, (_, i) => seedFact(`Taylor fact ${i}`));
    const before = graphLineCount();
    const stubIdentify = vi.fn().mockReturnValue(robinIdentification(facts.map((f) => f.id)));

    const status = resolutionWorker({ dryRun: true, identify: stubIdentify });

    // The LLM identification step still runs in dry-run (operator review) …
    expect(stubIdentify).toHaveBeenCalledTimes(1);
    // … but ZERO graph writes happen — the file is unchanged and no node was persisted.
    expect(graphLineCount()).toBe(before);
    expect(searchEntities('Taylor', 'Person')).toHaveLength(0);
    // The status counters reflect what WOULD have been written (linkRelationDraft counts in dry-run),
    // proving the identify pass ran end-to-end — but nothing touched disk (asserted above). Per AC-9
    // the status may report the would-be counts; the hard invariant is the zero-write file state.
    expect(status.named_nodes_minted).toBe(1);
    expect(status.edges_linked).toBe(3);
  });
});
