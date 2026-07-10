import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Track 9 Phase 3 — the dedup/merge worker (lib/maintainer.ts, Worker 2) + the EC-5 edge re-point.
// Harness mirrors maintainer-resolution.test.ts: MOT_EMBED_DISABLE=1 (suite-wide via vitest.config)
// and MOT_GRAPH_PATH pointed at a temp .jsonl file, BOTH before the first dynamic import (graphPath()
// reads the env lazily on every call). dedupWorker takes an injectable `identify` — every test passes
// a stub so NO test ever spawns a real `claude -p`. mergeGroup + computeRepointedEdges are pure and
// unit-tested directly; repointEdges (now taking the WHOLE pass-wide dup→survivor Map) is tested
// against a temp graph file.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-maint-dedup-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

const { dedupWorker, mergeGroup, computeRepointedEdges, repointEdges } = await import(
  '../../lib/maintainer'
);
const {
  appendEntity,
  appendRelate,
  appendUnrelate,
  appendConfirmRelate,
  appendSupersede,
  loadGraph,
  relatedEntities,
} = await import('../../lib/graph');
type EntityRecord = import('../../lib/graph').EntityRecord;
type RelatePatch = import('../../lib/graph').RelatePatch;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

function resetGraph(): void {
  fs.mkdirSync(path.dirname(graphFile), { recursive: true });
  fs.writeFileSync(graphFile, '');
  // Clear any .bak-* files a prior test left in tmpDir so the "no backup" assertion is clean.
  for (const f of fs.readdirSync(tmpDir)) {
    if (f.includes('.bak-')) fs.rmSync(path.join(tmpDir, f), { force: true });
  }
}

// Seed a named entity of a given type/label with arbitrary props/confidence.
function seedEntity(
  type: EntityRecord['type'],
  label: string,
  opts: { confidence?: number; properties?: Record<string, unknown>; valid_from?: string } = {},
): EntityRecord {
  return appendEntity({
    type,
    label,
    properties: opts.properties ?? {},
    confidence: opts.confidence ?? 0.9,
    confirmed: false,
    source: 'session:seed',
    valid_from: opts.valid_from ?? '2026-06-01T00:00:00.000Z',
    valid_until: null,
    superseded_by: null,
  });
}

function readLines(): string[] {
  if (!fs.existsSync(graphFile)) return [];
  return fs.readFileSync(graphFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
}
function graphLineCount(): number {
  return readLines().length;
}
function bakFiles(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.includes('.bak-'));
}
function supersedeCount(): number {
  return readLines().filter((l) => {
    try {
      return (JSON.parse(l) as { op?: string }).op === 'supersede';
    } catch {
      return false;
    }
  }).length;
}

describe('Track 9 Phase 3 — dedup worker (lib/maintainer)', () => {
  it('EC-4 / FR-10 — mergeGroup unions all properties, canonical wins on conflict, no key dropped', () => {
    // Two same-type entities with overlapping + non-overlapping keys. `a` is the higher-confidence
    // survivor; on the shared key `role` the survivor's value must win; every OTHER key survives.
    const a: EntityRecord = {
      id: 'a', type: 'Person', label: 'Taylor',
      properties: { role: 'owner', email: 'a@x.com' },
      confidence: 0.95, confirmed: false, source: 'session:1',
      valid_from: '2026-06-01T00:00:00.000Z', valid_until: null, superseded_by: null,
    };
    const b: EntityRecord = {
      id: 'b', type: 'Person', label: 'Taylor',
      properties: { role: 'admin', phone: '555', city: 'YVR' },
      confidence: 0.8, confirmed: false, source: 'session:2',
      valid_from: '2026-06-02T00:00:00.000Z', valid_until: null, superseded_by: null,
    };

    const { survivor, mergedAway } = mergeGroup([b, a]); // order-independent

    expect(survivor.id).toBe('a'); // highest confidence wins selection
    expect(mergedAway.map((x) => x.id)).toEqual(['b']);
    // canonical (survivor) wins on the conflicting key …
    expect(survivor.properties.role).toBe('owner');
    // … and EVERY other key from BOTH entities is present — no key dropped (FR-10 hard).
    expect(survivor.properties.email).toBe('a@x.com');
    expect(survivor.properties.phone).toBe('555');
    expect(survivor.properties.city).toBe('YVR');
  });

  it('computeRepointedEdges — re-points endpoints and DROPS a self-loop (pure, no I/O)', () => {
    const map = new Map<string, string>([['dup', 'surv']]);
    const base = (from: string, to: string): RelatePatch => ({
      op: 'relate', from, rel: 'points_to', to, confidence: 0.9, source: 'session:x',
      valid_from: '2026-06-01T00:00:00.000Z', valid_until: null, confirmed: false, ts: '2026-06-01T00:00:00.000Z',
    });
    // dup→C re-points to surv→C (kept); dup→surv collapses to surv→surv (dropped, B2).
    const out = computeRepointedEdges([base('dup', 'C'), base('dup', 'surv')], map);
    expect(out).toHaveLength(1);
    expect(out[0].from).toBe('surv');
    expect(out[0].to).toBe('C');
  });

  it('AC-3 / W2 — deterministic pre-pass merges exact (type,label) duplicates with NO LLM call', () => {
    resetGraph();
    seedEntity('Person', 'Taylor', { confidence: 0.95, properties: { role: 'owner' } });
    seedEntity('Person', 'Taylor', { confidence: 0.8, properties: { city: 'YVR' } });
    const identify = vi.fn().mockReturnValue({ groups: [] }); // no fuzzy groups

    const status = dedupWorker({ dryRun: false, identify });

    // The exact-duplicate pre-pass never consults the LLM (it may still fire for OTHER type batches,
    // but here the ONLY same-type group is the exact pair — merged deterministically). Assert the
    // pre-pass did the merge and did not need `identify` to see this pair as ≥2.
    expect(status.entities_merged).toBe(1);

    const activeTaylors = loadGraph().filter(
      (e) => e.superseded_by === null && e.type === 'Person' && e.label === 'Taylor',
    );
    expect(activeTaylors).toHaveLength(1); // only one survivor active
    // Both entities' properties present on the survivor (union, no key dropped).
    expect(activeTaylors[0].properties.role).toBe('owner');
    expect(activeTaylors[0].properties.city).toBe('YVR');
  });

  it('AC-6a / EC-5 / B1 — a human unrelate is preserved across a merge (survivor edge EXPIRED)', () => {
    resetGraph();
    const A = seedEntity('Fact', 'A-dup');
    const B = seedEntity('Person', 'B-survivor');
    const C = seedEntity('Fact', 'C-target');
    // A points_to C, then a human REJECTS it (unrelate). Fold state for A→C is EXPIRED.
    appendRelate(A.id, 'points_to', C.id, 0.9, 'session:s', false);
    appendUnrelate(A.id, 'points_to', C.id);

    // Merge A → B: re-point every triple touching A onto B.
    repointEdges(new Map([[A.id, B.id]]), graphFile);

    // A fresh loadGraph() must report B→C EXPIRED — B's live relations must NOT contain it.
    const active = loadGraph();
    const b = active.find((e) => e.id === B.id)!;
    const liveToC = (b.properties.relations ?? []).some(
      (r) => r.rel === 'points_to' && r.target_id === C.id,
    );
    expect(liveToC).toBe(false); // the human unrelate survived the merge — edge stays expired
    // And relatedEntities(B) must not surface C via that edge.
    expect(relatedEntities(B.id).map((n) => n.id)).not.toContain(C.id);
  });

  it('AC-6b — a human confirm_relate is preserved across a merge (survivor edge CONFIRMED)', () => {
    resetGraph();
    const A = seedEntity('Fact', 'A-dup');
    const B = seedEntity('Person', 'B-survivor');
    const C = seedEntity('Fact', 'C-target');
    appendRelate(A.id, 'points_to', C.id, 0.9, 'session:s', false);
    appendConfirmRelate(A.id, 'points_to', C.id); // human affirmation

    repointEdges(new Map([[A.id, B.id]]), graphFile);

    const active = loadGraph();
    const b = active.find((e) => e.id === B.id)!;
    const edge = (b.properties.relations ?? []).find(
      (r) => r.rel === 'points_to' && r.target_id === C.id,
    );
    expect(edge).toBeDefined(); // live …
    expect(edge!.confirmed).toBe(true); // … and CONFIRMED (the affirmation carried over)
  });

  it('AC-6d / EC-5 (confirmed+rejected) — a CONFIRMED-then-REJECTED edge stays EXPIRED across a merge', () => {
    // The sub-case AC-6a missed: an edge a human first CONFIRMED (confirm_relate) and THEN
    // REJECTED (unrelate) folds to confirmed:true AND valid_until=unrelate.ts. appendResolvedRelate
    // writes that one resolved patch (confirmed:true, valid_until non-null) onto the survivor triple.
    // The re-fold on loadGraph() must honour the pre-expired valid_until REGARDLESS of confirmed —
    // else the survivor edge resurrects LIVE and the human's rejection is silently lost.
    resetGraph();
    const A = seedEntity('Fact', 'A-dup');
    const B = seedEntity('Person', 'B-survivor');
    const C = seedEntity('Fact', 'C-target');
    appendRelate(A.id, 'points_to', C.id, 0.9, 'session:s', false);
    appendConfirmRelate(A.id, 'points_to', C.id); // human affirms …
    appendUnrelate(A.id, 'points_to', C.id); //     … then human REJECTS. Fold: confirmed+expired.

    repointEdges(new Map([[A.id, B.id]]), graphFile);

    // A fresh loadGraph() must fold the survivor edge B→C EXPIRED — NOT live.
    const active = loadGraph();
    const b = active.find((e) => e.id === B.id)!;
    const liveToC = (b.properties.relations ?? []).some(
      (r) => r.rel === 'points_to' && r.target_id === C.id,
    );
    expect(liveToC).toBe(false); // the rejection survived even though the edge was once confirmed
    // relatedEntities(B) must not surface C via the rejected edge.
    expect(relatedEntities(B.id).map((n) => n.id)).not.toContain(C.id);
  });

  it('AC-6e — a CONFIRMED-and-LIVE edge stays CONFIRMED + live across a merge (mirror of AC-6d)', () => {
    // The confirmed:true + valid_until:null case must still fold back LIVE + confirmed — proving the
    // fix does not over-expire a confirmed edge that was never rejected.
    resetGraph();
    const A = seedEntity('Fact', 'A-dup');
    const B = seedEntity('Person', 'B-survivor');
    const C = seedEntity('Fact', 'C-target');
    appendRelate(A.id, 'points_to', C.id, 0.9, 'session:s', false);
    appendConfirmRelate(A.id, 'points_to', C.id); // human affirms, no later unrelate

    repointEdges(new Map([[A.id, B.id]]), graphFile);

    const active = loadGraph();
    const b = active.find((e) => e.id === B.id)!;
    const edge = (b.properties.relations ?? []).find(
      (r) => r.rel === 'points_to' && r.target_id === C.id,
    );
    expect(edge).toBeDefined(); // still live …
    expect(edge!.confirmed).toBe(true); // … and CONFIRMED
    expect(relatedEntities(B.id).map((n) => n.id)).toContain(C.id);
  });

  it('AC-6c / EC-11 / B2 — a re-point that self-loops writes NO relate line', () => {
    resetGraph();
    const A = seedEntity('Fact', 'A-dup');
    const B = seedEntity('Person', 'B-survivor');
    // A points_to B — merging A→B collapses this into B→B (a self-loop).
    appendRelate(A.id, 'points_to', B.id, 0.9, 'session:s', false);

    // Mirror a real merge: A is superseded (so the stale A→B relate no longer surfaces — its from is
    // a superseded node the fold skips), then re-point A's edges onto B.
    appendSupersede(A.id, B.id);
    repointEdges(new Map([[A.id, B.id]]), graphFile);

    // No survivor self-loop line must exist in the file.
    const selfLoop = readLines().some((l) => {
      try {
        const r = JSON.parse(l) as { op?: string; from?: string; rel?: string; to?: string };
        return r.op === 'relate' && r.from === B.id && r.rel === 'points_to' && r.to === B.id;
      } catch {
        return false;
      }
    });
    expect(selfLoop).toBe(false);
    expect(relatedEntities(B.id)).toHaveLength(0); // B relates to nothing (self-loop dropped)
  });

  it('AC-4 / FR-17 — the merged-away entity remains in the JSONL (superseded, not deleted)', () => {
    resetGraph();
    const first = seedEntity('Person', 'Taylor', { confidence: 0.95 });
    const dup = seedEntity('Person', 'Taylor', { confidence: 0.8 });
    const identify = vi.fn().mockReturnValue({ groups: [] });

    dedupWorker({ dryRun: false, identify });

    // Exactly one supersede was written and the merged-away entity's record line still appears raw.
    expect(supersedeCount()).toBe(1);
    const mergedAwayId = dup.confidence < first.confidence ? dup.id : first.id;
    const stillPresent = readLines().some((l) => {
      try {
        const r = JSON.parse(l) as { id?: string; op?: string };
        return r.op === undefined && r.id === mergedAwayId;
      } catch {
        return false;
      }
    });
    expect(stillPresent).toBe(true); // content preserved (append-only, recoverable)
  });

  it('AC-5 / FR-19 — a re-run over the same state writes no second supersede (idempotent)', () => {
    resetGraph();
    seedEntity('Person', 'Taylor', { confidence: 0.95 });
    seedEntity('Person', 'Taylor', { confidence: 0.8 });
    const identify = vi.fn().mockReturnValue({ groups: [] });

    dedupWorker({ dryRun: false, identify });
    const afterFirst = graphLineCount();
    const supersedesAfterFirst = supersedeCount();

    // Second pass: the sole exact-dup group now has only ONE active member (the loser is superseded),
    // so the pre-pass skips it; and even if re-considered, the superseded_by !== null skip fires.
    dedupWorker({ dryRun: false, identify });

    expect(supersedeCount()).toBe(supersedesAfterFirst); // no second supersede
    expect(graphLineCount()).toBe(afterFirst); // no new lines at all
  });

  it('FR-13 / AC-9 — dry_run writes no supersede line and creates NO .bak file', () => {
    resetGraph();
    seedEntity('Person', 'Taylor', { confidence: 0.95 });
    seedEntity('Person', 'Taylor', { confidence: 0.8 });
    const before = graphLineCount();
    const identify = vi.fn().mockReturnValue({ groups: [] });

    const status = dedupWorker({ dryRun: true, identify });

    expect(supersedeCount()).toBe(0); // no supersede op written
    expect(graphLineCount()).toBe(before); // nothing appended
    expect(bakFiles()).toHaveLength(0); // no backup taken in dry-run
    expect(status.backup_path).toBeNull();
  });

  it('B4 — a single-member LLM "group" is a NO-OP (no lone entity is superseded on a boolean)', () => {
    resetGraph();
    const solo = seedEntity('Fact', 'example.com', { confidence: 0.9 });
    // The LLM returns a 1-member group (a retype attempt). B4: this must be discarded — no supersede.
    const identify = vi.fn().mockReturnValue({
      groups: [
        { canonical_label: 'example.com', canonical_type: 'Fact', member_ids: [solo.id], confidence: 0.95, reason: 'test' },
      ],
    });

    const status = dedupWorker({ dryRun: false, identify });

    expect(status.entities_merged).toBe(0);
    expect(supersedeCount()).toBe(0);
    // The lone entity is untouched and still active.
    const stillActive = loadGraph().find((e) => e.id === solo.id);
    expect(stillActive).toBeDefined();
    expect(stillActive!.superseded_by).toBeNull();
  });

  it('W2 — the exact-label pre-merge collapses a duplicate with NO identify call for that pair', () => {
    resetGraph();
    // ONLY a same-label exact pair exists — no other multi-member type group — so identify is never
    // needed to catch it (the deterministic pre-pass handles it). Assert identify saw no ≥2 group
    // that produced a merge, i.e. the merge came from the pre-pass, not the LLM.
    seedEntity('Person', 'Taylor', { confidence: 0.95, properties: { a: 1 } });
    seedEntity('Person', 'Taylor', { confidence: 0.9, properties: { b: 2 } });
    const identify = vi.fn().mockReturnValue({ groups: [] });

    const status = dedupWorker({ dryRun: false, identify });

    // The merge happened …
    expect(status.entities_merged).toBe(1);
    // … and because it happened in the deterministic pre-pass, the survivor already carries the union
    // even though `identify` returned an empty group list (the LLM was not the mechanism).
    const survivor = loadGraph().find(
      (e) => e.superseded_by === null && e.type === 'Person' && e.label === 'Taylor',
    )!;
    expect(survivor.properties.a).toBe(1);
    expect(survivor.properties.b).toBe(2);
  });

  it('EC-12 — a live edge between TWO merge groups’ losers re-points to survivorA→survivorB (no phantom edge)', () => {
    // THE BLOCKER. Two exact-label dup groups collapse in the SAME pass, and a live edge exists
    // between their LOSERS. The old per-group single-entry repointEdges re-pointed only the a-loser,
    // leaving survivorA -> (dead) b1 pointing at a superseded node forever (a phantom neighbour in
    // relatedEntities). The whole-pass map folds BOTH endpoints: a1->b1 becomes survivorA->survivorB.
    resetGraph();
    // Group A: survivor a2 (conf 0.95) + loser a1 (conf 0.8). Same exact label -> pre-pass merges.
    const a1 = seedEntity('Person', 'GroupA', { confidence: 0.8 });
    const a2 = seedEntity('Person', 'GroupA', { confidence: 0.95 });
    // Group B: survivor b2 (conf 0.95) + loser b1 (conf 0.8).
    const b1 = seedEntity('Person', 'GroupB', { confidence: 0.8 });
    const b2 = seedEntity('Person', 'GroupB', { confidence: 0.95 });
    // The live edge between the two groups' LOSERS.
    appendRelate(a1.id, 'points_to', b1.id, 0.9, 'session:s', false);

    const identify = vi.fn().mockReturnValue({ groups: [] }); // exact pre-pass does both merges

    dedupWorker({ dryRun: false, identify });

    // Both survivors are a2 and b2 (highest confidence in each group); a1 and b1 are superseded.
    const folded = loadGraph();
    const foldedById = new Map(folded.map((e) => [e.id, e]));
    const active = folded.filter((e) => e.superseded_by === null);
    const byId = new Map(active.map((e) => [e.id, e]));
    const survA = a2.id;
    const survB = b2.id;
    // a1 and b1 are superseded away (still present in the fold, but no longer active).
    expect(foldedById.get(a1.id)?.superseded_by).not.toBeNull();
    expect(foldedById.get(b1.id)?.superseded_by).not.toBeNull();
    expect(byId.has(a1.id)).toBe(false); // not in the active set
    expect(byId.has(b1.id)).toBe(false);

    // NO LIVE edge in the folded graph may point AT a superseded node. Walk every ACTIVE entity's
    // live relations[] and assert every target resolves to an ACTIVE node (never a superseded id).
    for (const e of active) {
      for (const rel of e.properties.relations ?? []) {
        expect(
          byId.get(rel.target_id),
          `live edge ${e.id} -> ${rel.target_id} points at a non-active node`,
        ).toBeDefined();
      }
    }

    // The surviving edge is survivorA -> survivorB (both endpoints resolved), and it surfaces as a
    // neighbour of survivorA — with survivorB, NOT the dead b1.
    const survAedges = byId.get(survA)?.properties.relations ?? [];
    const edgeToSurvB = survAedges.find((r) => r.rel === 'points_to' && r.target_id === survB);
    expect(edgeToSurvB, 'survivorA must have a live points_to edge to survivorB').toBeDefined();
    // No live edge on survivorA points at the dead b1.
    expect(survAedges.some((r) => r.target_id === b1.id)).toBe(false);

    // relatedEntities(survivorA) shows survivorB and NOT the phantom dead b1.
    const relatedA = relatedEntities(survA).map((n) => n.id);
    expect(relatedA).toContain(survB);
    expect(relatedA).not.toContain(b1.id);

    // Stable across a SECOND pass: nothing new is written (FR-19 idempotent), and the graph still
    // has no live edge pointing at a superseded node.
    const linesAfterFirst = graphLineCount();
    dedupWorker({ dryRun: false, identify });
    expect(graphLineCount()).toBe(linesAfterFirst); // idempotent — no second-pass writes
    const active2 = loadGraph().filter((e) => e.superseded_by === null);
    const byId2 = new Map(active2.map((e) => [e.id, e]));
    for (const e of active2) {
      for (const rel of e.properties.relations ?? []) {
        expect(byId2.get(rel.target_id), `pass-2 phantom edge ${e.id} -> ${rel.target_id}`).toBeDefined();
      }
    }
    expect(relatedEntities(survA).map((n) => n.id)).not.toContain(b1.id);
  });

  it('W1 / FR-10 — a nested object value under a shared key is NOT lost on merge (deep union)', () => {
    // Canonical and loser BOTH carry a top-level object key `meta` with DISJOINT nested subkeys. A
    // shallow spread would keep only canonical's whole `meta` and silently drop the loser's nested
    // subkey. FR-10 (no value lost) requires a deep merge so BOTH nested subkeys survive; canonical
    // still wins on a true leaf collision.
    const canonical: EntityRecord = {
      id: 'canon', type: 'Person', label: 'Taylor',
      properties: { meta: { a: 1, shared: 'canon-wins' }, top: 'c' },
      confidence: 0.95, confirmed: false, source: 'session:1',
      valid_from: '2026-06-01T00:00:00.000Z', valid_until: null, superseded_by: null,
    };
    const loser: EntityRecord = {
      id: 'loser', type: 'Person', label: 'Taylor',
      properties: { meta: { b: 2, shared: 'loser-loses' }, other: 'l' },
      confidence: 0.8, confirmed: false, source: 'session:2',
      valid_from: '2026-06-02T00:00:00.000Z', valid_until: null, superseded_by: null,
    };

    const { survivor } = mergeGroup([loser, canonical]);

    expect(survivor.id).toBe('canon'); // highest confidence survives
    const meta = survivor.properties.meta as Record<string, unknown>;
    // BOTH nested subkeys present — the loser's `meta.b` was NOT dropped (W1/FR-10).
    expect(meta.a).toBe(1);
    expect(meta.b).toBe(2);
    // Canonical still wins on the genuinely-conflicting nested leaf.
    expect(meta.shared).toBe('canon-wins');
    // Top-level disjoint keys both survive too.
    expect(survivor.properties.top).toBe('c');
    expect(survivor.properties.other).toBe('l');
  });
});

describe('Track 9 Phase 3 — scripts/cleanup-entities.ts still reports + exits 0 on --dry-run', () => {
  it('runs a --dry-run cleanup pass against a temp graph without breaking the ops script', () => {
    // Isolated graph file for the child process (its own MOT_GRAPH_PATH), so we don't touch the
    // suite's graphFile. Seed two exact-label Person dups so there is a merge to REPORT (dry-run
    // reports but must NOT write, and must exit 0).
    const scriptTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-cleanup-'));
    const scriptGraph = path.join(scriptTmp, 'graph.jsonl');
    const mk = (id: string, conf: number) =>
      JSON.stringify({
        id, type: 'Person', label: 'Taylor', properties: {}, confidence: conf,
        confirmed: false, source: 'session:seed', valid_from: '2026-06-01T00:00:00.000Z',
        valid_until: null, superseded_by: null,
      });
    fs.writeFileSync(scriptGraph, mk('rob1', 0.95) + '\n' + mk('rob2', 0.8) + '\n');
    const before = fs.readFileSync(scriptGraph, 'utf8');

    const repoRoot = path.resolve(__dirname, '..', '..');
    let out = '';
    let exited0 = true;
    try {
      out = execFileSync('npx', ['tsx', 'scripts/cleanup-entities.ts', '--dry-run'], {
        cwd: repoRoot,
        env: { ...process.env, MOT_GRAPH_PATH: scriptGraph, MOT_EMBED_DISABLE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    } catch (e) {
      exited0 = false;
      out = String((e as { stdout?: string }).stdout ?? '') + String((e as Error).message);
    }

    expect(exited0).toBe(true); // process.exit(0) preserved on the dry-run path
    expect(out).toContain('[cleanup-entities]'); // the summary console.log still fires
    expect(out).toContain('dry-run'); // it reported dry-run mode
    // Dry-run must NOT have rewritten the graph file.
    expect(fs.readFileSync(scriptGraph, 'utf8')).toBe(before);

    fs.rmSync(scriptTmp, { recursive: true, force: true });
  });
});
