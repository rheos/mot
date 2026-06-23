// Recallatron Phase 2 — graph maintenance (Track 4, Prompt 2).
//
// Three nightly/admin maintenance primitives over the append-only ontology/graph.jsonl store:
//   - compactGraph         — fold all patches, drop superseded/pruned entities, rewrite atomically.
//   - prunePendingEntities — mark stale unconfirmed candidates as 'pruned' (a supersession patch).
//   - graphEntitySources   — GAP #2 idempotency primitive: every entity record's `source`,
//                            status-agnostic, consumed by scripts/backfill-extraction.ts (Prompt 5).
//
// `loadGraph` in lib/graph.ts is private (not exported, line 117). The OQ-2=option(b) decision is
// to raw-read the JSONL here and reproduce the supersede+confirm fold (lib/graph.ts:117-171) rather
// than export the internal reader. All three exports share one raw-read primitive (`readRecords`).

import fs from 'node:fs';
import path from 'node:path';
import {
  appendSupersede,
  type EntityRecord,
  type SupersessionPatch,
  type ConfirmPatch,
} from './graph';

// Server-only live data path (mirrors graph.ts:48-50 / backup.ts:31-33). Resolved at call time
// so tests can point MOT_GRAPH_PATH at a temp file (same lazy-env pattern as DATABASE_URL).
function defaultGraphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

// A parsed JSONL line is an entity record, a supersession patch, or a confirmation patch —
// the same three shapes lib/graph.ts discriminates on `op`.
type ParsedLine = EntityRecord | SupersessionPatch | ConfirmPatch;

function isSupersedePatch(rec: unknown): rec is SupersessionPatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'supersede';
}

function isConfirmPatch(rec: unknown): rec is ConfirmPatch {
  return typeof rec === 'object' && rec !== null && (rec as { op?: unknown }).op === 'confirm';
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
 * Fold the supersession + confirmation patches over the entity records, reproducing
 * lib/graph.ts:117-171. Returns the full entity Map (every entity, regardless of status) with
 * each entity's effective `superseded_by` / `confirmed` resolved. A patch for an unknown id is a
 * no-op (the entity may have been compacted away). The caller filters by status.
 */
function foldRecords(records: ParsedLine[]): Map<string, EntityRecord> {
  const entities = new Map<string, EntityRecord>();
  const patches: SupersessionPatch[] = [];
  const confirmPatches: ConfirmPatch[] = [];

  for (const rec of records) {
    if (isSupersedePatch(rec)) {
      patches.push(rec);
    } else if (isConfirmPatch(rec)) {
      confirmPatches.push(rec);
    } else {
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

  // Atomic replace: write the survivors to a temp file, then rename over the original. If the
  // process dies before the rename, the original survives untouched (EC-9).
  const tmp = graphPath + '.compact.tmp';
  const body = survivors.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(tmp, survivors.length > 0 ? body + '\n' : '');
  fs.renameSync(tmp, graphPath);

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
