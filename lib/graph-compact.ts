// Recallatron Phase 2 — graph maintenance (Track 4, Prompt 2).
//
// Three nightly/admin maintenance primitives over the append-only ontology/graph.jsonl store:
//   - compactGraph         — fold all patches, drop superseded/pruned entities, rewrite atomically.
//   - prunePendingEntities — mark stale unconfirmed candidates as 'pruned' (a supersession patch).
//   - graphEntitySources   — GAP #2 idempotency primitive: every entity record's `source`,
//                            status-agnostic, consumed by scripts/backfill-extraction.ts (Prompt 5).
//
// This module raw-reads the JSONL and reproduces the supersede+confirm fold from lib/graph.ts
// (OQ-2=option(b); loadGraph has since been exported for Track-5 retrieval, but the raw read
// stays — graphEntitySources needs the unfolded per-line records, which loadGraph discards).
// All three exports share one raw-read primitive (`readRecords`).

import fs from 'node:fs';
import path from 'node:path';
import {
  appendSupersede,
  resolveEdges,
  attachRelations,
  type EntityRecord,
  type SupersessionPatch,
  type ConfirmPatch,
  type RelatePatch,
  type ConfirmRelatePatch,
  type UnrelatePatch,
} from './graph';
import { getDb } from '../db/client';
import { vecDelete, vecAvailable } from './vec';
import { embeddingEnabled } from './embedding';

// Server-only live data path (mirrors graph.ts:48-50 / backup.ts:31-33). Resolved at call time
// so tests can point MOT_GRAPH_PATH at a temp file (same lazy-env pattern as DATABASE_URL).
function defaultGraphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

// A parsed JSONL line is an entity record, a supersession/confirmation patch, or one of the
// three Track-6 edge patches — the same six shapes lib/graph.ts discriminates on `op`.
type ParsedLine =
  | EntityRecord
  | SupersessionPatch
  | ConfirmPatch
  | RelatePatch
  | ConfirmRelatePatch
  | UnrelatePatch;

function isSupersedePatch(rec: unknown): rec is SupersessionPatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'supersede';
}

function isConfirmPatch(rec: unknown): rec is ConfirmPatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'confirm';
}

// Track 6 edge patch discriminators — same pattern as isSupersedePatch / isConfirmPatch
// (a local copy mirrors lib/graph.ts's private guards; the graph.ts fold owns edge semantics).
function isRelatePatch(rec: unknown): rec is RelatePatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'relate';
}
function isConfirmRelatePatch(rec: unknown): rec is ConfirmRelatePatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'confirm_relate';
}
function isUnrelatePatch(rec: unknown): rec is UnrelatePatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'unrelate';
}

/**
 * The shared raw-read primitive used by all three exports. Reads the JSONL file, splits on '\n',
 * skips empty lines, JSON.parses each line, and skips (log + continue) any malformed line — never
 * throws. Returns the parsed records in file order; the caller decides what to fold or collect.
 * Returns [] when the file is absent (callers handle the no-op/skip path themselves).
 */
function readRecords(graphPath: string): ParsedLine[] {
  if (!fs.existsSync(graphPath)) return [];
  const raw = fs.readFileSync(graphPath, 'utf8');
  const out: ParsedLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(`[MOT/graph-compact] skipped malformed line: ${line}`);
      continue;
    }
    out.push(parsed as ParsedLine);
  }
  return out;
}

/**
 * Fold the supersession + confirmation + edge patches over the entity records, reproducing
 * lib/graph.ts's loadGraph fold. Returns the full entity Map (every entity, regardless of status)
 * with each entity's effective `superseded_by` / `confirmed` and its `properties.relations[]`
 * (rebuilt wholesale from relate patches via the shared attachRelations) resolved. A patch for an
 * unknown id is a no-op (the entity may have been compacted away). The caller filters by status.
 *
 * The edge fold is load-bearing for prunePendingEntities: its guard at line 176 reads
 * `entity.properties.relations`, which is now populated from the relate patches — so an unconfirmed
 * entity with an outgoing relate patch is NOT pruned (FR14/EC10).
 */
function foldRecords(records: ParsedLine[]): Map<string, EntityRecord> {
  const entities = new Map<string, EntityRecord>();
  const patches: SupersessionPatch[] = [];
  const confirmPatches: ConfirmPatch[] = [];
  const relateBucket: RelatePatch[] = [];
  const confirmRelateBucket: ConfirmRelatePatch[] = [];
  const unrelateBucket: UnrelatePatch[] = [];

  for (const rec of records) {
    if (isSupersedePatch(rec)) {
      patches.push(rec);
    } else if (isConfirmPatch(rec)) {
      confirmPatches.push(rec);
    } else if (isRelatePatch(rec)) {
      relateBucket.push(rec);
    } else if (isConfirmRelatePatch(rec)) {
      confirmRelateBucket.push(rec);
    } else if (isUnrelatePatch(rec)) {
      unrelateBucket.push(rec);
    } else {
      // An id-less patch line MUST NOT reach here — it would set a garbage `undefined` key.
      const entity = rec as EntityRecord;
      entities.set(entity.id, entity);
    }
  }

  // Supersession patch fold: the patch is the mutation mechanism (covers real supersessions and
  // 'pruned'). A patch for an unknown id is a no-op.
  for (const patch of patches) {
    const target = entities.get(patch.old);
    if (target) target.superseded_by = patch.new;
  }

  // Confirmation patch fold.
  for (const cp of confirmPatches) {
    const target = entities.get(cp.id);
    if (target) target.confirmed = true;
  }

  // Edge fold (Track 6): resolve the (from, rel, to) triples and rebuild every entity's effective
  // properties.relations[] via the SHARED helpers from lib/graph — no third copy of edge semantics.
  // `resolvedEdges` is a local, consumed only by attachRelations; it is NOT returned (the return
  // type stays Map<string,EntityRecord>, which prunePendingEntities / graphEntitySources depend on).
  const resolvedEdges = resolveEdges(relateBucket, confirmRelateBucket, unrelateBucket);
  attachRelations(entities, resolvedEdges);

  return entities;
}

/**
 * Compact graph.jsonl: fold all patches and rewrite only the survivors (active, non-superseded
 * entity records — those whose resolved `superseded_by === null`, which drops both 'pruned' and
 * real supersessions). Writes atomically via write-temp-then-rename so a crash mid-write leaves
 * the original file intact (EC-9). No-op + log when the file is absent (AC-9).
 */
export async function compactGraph(graphPath: string): Promise<void> {
  if (!fs.existsSync(graphPath)) {
    console.log(`[MOT/graph-compact] no graph file at ${graphPath}, skipping`);
    return;
  }

  const records = readRecords(graphPath);
  const entities = foldRecords(records);

  const survivors = [...entities.values()].filter((e) => e.superseded_by === null);
  // Hoisted above the atomic write so it gates BOTH edge emission and the vec-prune loop below.
  const survivorSet = new Set(survivors.map((e) => e.id));

  // Re-derive the edge buckets from `records` (foldRecords' resolvedEdges is a local there, not
  // returned) and resolve them via the SHARED fold. Emit only LIVE edges whose `from` survived
  // compaction — expired edges (valid_until !== null) and edges off a dropped `from` are gone.
  // The confirmed one-way latch bakes any confirm_relate into the relate line's confirmed flag,
  // so a later automated relate(confirmed:false) can't downgrade a compacted-confirmed edge
  // (blocker path b). confirm_relate / unrelate lines are collapsed away — not re-emitted.
  const relateBucket: RelatePatch[] = [];
  const confirmRelateBucket: ConfirmRelatePatch[] = [];
  const unrelateBucket: UnrelatePatch[] = [];
  for (const rec of records) {
    if (isRelatePatch(rec)) relateBucket.push(rec);
    else if (isConfirmRelatePatch(rec)) confirmRelateBucket.push(rec);
    else if (isUnrelatePatch(rec)) unrelateBucket.push(rec);
  }
  const compactedEdges = resolveEdges(relateBucket, confirmRelateBucket, unrelateBucket).filter(
    (e) => e.valid_until === null && survivorSet.has(e.from),
  );

  // Atomic replace: write the survivor entity lines AND the resolved live edge lines to a temp
  // file, then rename over the original. If the process dies before the rename, the original
  // survives untouched (EC-9). Both entity and edge lines go in the same atomic write.
  const tmp = graphPath + '.compact.tmp';
  const entityBody = survivors.map((e) => JSON.stringify(e)).join('\n');
  const edgeBody = compactedEdges.map((e) => JSON.stringify(e)).join('\n');
  const body = [entityBody, edgeBody].filter(Boolean).join('\n');
  fs.writeFileSync(tmp, body.length > 0 ? body + '\n' : '');
  fs.renameSync(tmp, graphPath);

  // FR 9: synchronously prune entity_vec for every entity that did not survive compaction.
  // This is admin-only (no user-facing latency budget) so synchronous is fine.
  // Double-gated like indexAsync (W1): vecAvailable() alone means "extension loaded", not
  // "vec tables exist" — in the embed-off test suite the 0007 tables are absent.
  if (embeddingEnabled() && vecAvailable()) {
    const db = getDb();
    for (const e of entities.values()) {
      if (!survivorSet.has(e.id)) {
        try {
          vecDelete(db, 'entity_vec', e.id);
        } catch (err) {
          console.error('[MOT/vec] entity_vec prune error for', e.id, err);
        }
      }
    }
  }

  console.log(
    `[MOT/graph-compact] compacted: ${records.length} records → ${survivors.length} active entities`,
  );
}

/**
 * Prune stale unconfirmed entity candidates: for each entity that is unconfirmed, not already
 * superseded/pruned, low-confidence, with no outgoing relations, and older than `maxAgeDays`,
 * append a 'pruned' supersession patch via appendSupersede(id, 'pruned') — NOT the entity_supersede
 * MCP tool, which rejects 'pruned' as target_not_found (mcp-tools.ts:655).
 *
 * The `superseded_by === null` filter is load-bearing: it prevents a second 'pruned' append on a
 * re-run (EC-6). null/malformed `valid_from` is skipped gracefully (EC-10).
 */
export function prunePendingEntities(maxAgeDays = 30): void {
  const graphPath = defaultGraphPath();
  // Raw-read + fold the full graph (every entity, including unconfirmed — do NOT filter to
  // active-only here; we need the unconfirmed candidates).
  const entities = foldRecords(readRecords(graphPath));

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const cutoffMs = Date.parse(cutoff);

  let count = 0;
  for (const entity of entities.values()) {
    if (entity.confirmed !== false) continue;
    if (entity.superseded_by !== null) continue; // EC-6: already pruned/superseded → skip
    if (entity.confidence >= 0.85) continue;
    if ((entity.properties.relations ?? []).length !== 0) continue; // has outgoing relations

    // EC-10: null/malformed valid_from must not throw and must not be pruned.
    const validFromMs = Date.parse(entity.valid_from);
    if (Number.isNaN(validFromMs)) continue;
    if (validFromMs >= cutoffMs) continue; // not yet stale

    appendSupersede(entity.id, 'pruned');
    count++;
  }

  console.log(`[MOT/nightly] entity prune: ${count} candidates marked as pruned`);
}

/**
 * GAP #2 idempotency primitive — consumed by scripts/backfill-extraction.ts (Prompt 5).
 *
 * Returns the set of entity `source` values present in graph.jsonl, STATUS-AGNOSTIC: pruned,
 * superseded, unconfirmed, and active entities all contribute their source. The backfill uses this
 * to skip digests it has already extracted; entity extraction is NOT internally idempotent
 * (appendEntity is unconditional at extraction.ts:148 and mints a fresh id at graph.ts:66), so the
 * skip-set is what makes the backfill idempotent for entities.
 *
 * Deliberately does NOT use searchEntities (active-only, graph.ts:235) and does NOT fold patches or
 * filter by superseded_by/valid_until — a pruned or superseded digest's source must NOT be omitted,
 * or the backfill would re-admit (re-append duplicate entities for) that digest on a re-run. `source`
 * never changes across patches, so no fold is needed; we read it straight off each entity line.
 */
export function graphEntitySources(graphPath: string): Set<string> {
  const sources = new Set<string>();
  // readRecords returns [] for an absent file → empty set, matching the contract.
  for (const rec of readRecords(graphPath)) {
    // Skip patch lines — they carry no `source`. Read `source` off every entity record line,
    // regardless of its eventual folded status.
    if (isSupersedePatch(rec) || isConfirmPatch(rec)) continue;
    const entity = rec as EntityRecord;
    if (typeof entity.source === 'string') sources.add(entity.source);
  }
  return sources;
}
