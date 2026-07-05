// Recallatron Phase 2 — the entity graph (FR 6–11).
//
// Append-only JSONL store at ontology/graph.jsonl (gitignored; server-only live data, OQ-1=B).
// The file holds two record shapes, distinguished by `op`:
//   - an entity record (no `op`)            — a node in the graph
//   - a supersession patch (`op:"supersede"`) — the ONLY mutation mechanism
// The file is never rewritten. `loadGraph` folds the supersession patches over the entity
// records to compute each entity's effective `superseded_by`. Edges live at
// `properties.relations[]` (OQ-4): an outbound edge is `{ rel, target_id }`.

import fs from 'node:fs';
import path from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { nowIso } from './time';
import { getDb } from '../db/client';
import { indexAsync, vecKnn, vecAvailable } from './vec';
import { embed, embeddingEnabled } from './embedding';
import { rrfMerge } from './rrf';

export interface EntityRecord {
  id: string;
  type: 'Person' | 'Project' | 'Deadline' | 'Preference' | 'Fact';
  label: string;
  properties: {
    relations?: { rel: string; target_id: string }[];
    probable_duplicate_of?: string[];
    [k: string]: unknown;
  };
  valid_from: string; // ISO datetime
  valid_until: string | null;
  confidence: number; // 0.0–1.0
  source: string; // "conversation:<turn_id>" | "session:<session_id>" | "manual"
  superseded_by: string | null;
  confirmed: boolean;
}

export interface SupersessionPatch {
  op: 'supersede';
  old: string;
  new: string;
  ts: string;
}

export interface ConfirmPatch {
  op: 'confirm';
  id: string;   // entity id being confirmed in place — id does NOT change (FR-1)
  ts: string;   // nowIso()
}

// Server-only live data path. Read lazily (not at module load) so tests can point
// MOT_GRAPH_PATH at a temp file — same lazy-env pattern as DATABASE_URL in db/client.ts.
function graphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

// Lazily create the containing directory (never via a SQL migration — the ontology/ dir
// does not exist until the first append). recursive so a temp parent is created too.
function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

const FIVE_MB = 5 * 1024 * 1024;

/**
 * Append a new entity record. Generates the `id`, ensures the directory exists, and
 * appends `JSON.stringify(rec) + '\n'` in a SINGLE appendFileSync call (one write
 * syscall — AC-4; no temp-file rename). Returns the full record with its generated id.
 */
export function appendEntity(rec: Omit<EntityRecord, 'id'>): EntityRecord {
  const full: EntityRecord = { ...rec, id: createId() };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(full) + '\n');
  // Fire-and-forget vec indexing AFTER the durable JSONL append (FR 4/7), keyed on the
  // cuid2 string id — not a SQLite rowid.
  indexAsync(
    getDb(),
    'entity_vec',
    full.id,
    full.label + ' ' + JSON.stringify(full.properties),
  );
  return full;
}

/**
 * Append a supersession patch marking `oldId` as superseded by `newId`. Same
 * single-syscall append pattern as appendEntity.
 */
export function appendSupersede(oldId: string, newId: string): void {
  const patch: SupersessionPatch = { op: 'supersede', old: oldId, new: newId, ts: nowIso() };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(patch) + '\n');
}

/**
 * Append a confirmation patch marking `id` as confirmed in place. The entity's id does not
 * change. Same single-syscall append pattern as appendEntity / appendSupersede.
 */
export function appendEntityConfirm(id: string): void {
  const patch: ConfirmPatch = { op: 'confirm', id, ts: nowIso() };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(patch) + '\n');
}

// A parsed line is an entity record, a supersession patch, or a confirmation patch.
function isSupersedePatch(rec: unknown): rec is SupersessionPatch {
  return (
    typeof rec === 'object' &&
    rec !== null &&
    (rec as { op?: unknown }).op === 'supersede'
  );
}

function isConfirmPatch(rec: unknown): rec is ConfirmPatch {
  return (
    typeof rec === 'object' &&
    rec !== null &&
    (rec as { op?: unknown }).op === 'confirm'
  );
}

/**
 * Read the JSONL file and fold supersession patches over the entity records.
 * Exported for Track-5 vector retrieval (KNN entity-id resolution against the folded
 * graph). Tolerant of malformed lines (EC-1, AC-13): a line that fails JSON.parse is
 * logged and skipped, never thrown.
 */
export function loadGraph(): EntityRecord[] {
  const file = graphPath();
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, 'utf8');

  // EC-9: a very large append-only log is a compaction signal, not an error.
  if (Buffer.byteLength(raw, 'utf8') >= FIVE_MB) {
    console.warn('[MOT/graph] graph.jsonl exceeds 5MB — consider compaction');
  }

  const entities = new Map<string, EntityRecord>();
  const patches: SupersessionPatch[] = [];
  const confirmPatches: ConfirmPatch[] = [];

  const lines = raw.split('\n');
  let offset = 0; // byte offset of the current line's start, for the skip log
  for (const line of lines) {
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the split '\n'
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(`[MOT/graph] skipped malformed line at offset ${lineStart}: ${line}`);
      continue;
    }

    if (isSupersedePatch(parsed)) {
      patches.push(parsed);
    } else if (isConfirmPatch(parsed)) {
      confirmPatches.push(parsed);
    } else {
      const rec = parsed as EntityRecord;
      entities.set(rec.id, rec);
    }
  }

  // Fold supersession patches: the patch is the mutation mechanism. A patch for an
  // unknown id is a no-op (the entity record may have been compacted away).
  for (const patch of patches) {
    const target = entities.get(patch.old);
    if (target) target.superseded_by = patch.new;
  }

  // Apply confirmation patches.
  for (const cp of confirmPatches) {
    const target = entities.get(cp.id);
    if (target) target.confirmed = true;
  }

  return [...entities.values()];
}

// Resolve a list of target_ids to their entity records, skipping any that are missing.
function resolveTargets(ids: string[], byId: Map<string, EntityRecord>): EntityRecord[] {
  const out: EntityRecord[] = [];
  for (const id of ids) {
    const rec = byId.get(id);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Fetch one entity plus its 1-hop neighbours. Edges live at properties.relations[]
 * (OQ-4). Returns null if `id` is not in the graph.
 *   - outbound: entities this one points at (its relations[].target_id, resolved)
 *   - inbound:  entities that point at this one (their relations contain {target_id: id})
 */
export function getEntity(id: string): {
  record: EntityRecord;
  relations: { outbound: EntityRecord[]; inbound: EntityRecord[] };
} | null {
  const all = loadGraph();
  const byId = new Map(all.map((e) => [e.id, e]));

  const record = byId.get(id);
  if (!record) return null;

  const outboundIds = (record.properties.relations ?? []).map((r) => r.target_id);
  const outbound = resolveTargets(outboundIds, byId);

  const inbound = all.filter(
    (e) => e.id !== id && (e.properties.relations ?? []).some((r) => r.target_id === id),
  );

  return { record, relations: { outbound, inbound } };
}

// The ONE result bound for the entity vector/hybrid arms: vector mode truncates to it,
// hybrid passes it to rrfMerge AND to the FTS-fallback truncation (replaces the old
// hard-coded rrfMerge-20 / vector-256 asymmetry). 50 matches the AC-6 graph result cap
// (relatedEntities' 50-entity ceiling) — the sync fts arm is uncapped, but the entity
// store is small (extraction.ts warns at ≥1000 actives), so 50 preserves the fts arm's
// effective full-result behavior in practice. The sync fts arm itself stays uncapped.
const ENTITY_SEARCH_LIMIT = 50;

/**
 * Keyword / semantic search over the graph (FR 7, FR 11).
 *   - default (mode 'fts' / no mode): case-insensitive substring match against the label
 *     and serialized properties — SYNC, returns EntityRecord[]. Existing ≤3-arg call sites
 *     (extraction.ts dedup scan, mcp-tools.ts entity_search) bind here unchanged (AC-4).
 *   - mode 'vector': sqlite-vec KNN over entity_vec, resolved back against loadGraph().
 *   - mode 'hybrid': RRF-merge of the fts and vector result lists (FR 14).
 * Active/confirmed filtering is identical across arms:
 *   - default: active records only (superseded_by === null && valid_until === null) — AC-5
 *   - unconfirmedOnly: confirmed === false && superseded_by === null — AC-5
 *   - type: additionally filter by entity type.
 */
// Sync overload — ≤3-arg call sites (extraction.ts, mcp-tools.ts fts path) bind here.
export function searchEntities(
  q: string,
  type?: EntityRecord['type'],
  unconfirmedOnly?: boolean,
): EntityRecord[];
// Async overload — 4-arg callers with mode:'vector'|'hybrid'.
export function searchEntities(
  q: string,
  type: EntityRecord['type'] | undefined,
  unconfirmedOnly: boolean | undefined,
  mode: 'vector' | 'hybrid',
): Promise<EntityRecord[]>;
// Implementation.
export function searchEntities(
  q: string,
  type?: EntityRecord['type'],
  unconfirmedOnly?: boolean,
  mode?: 'fts' | 'vector' | 'hybrid',
): EntityRecord[] | Promise<EntityRecord[]> {
  if (!mode || mode === 'fts') {
    // Existing in-memory substring search — verbatim, do not change.
    const all = loadGraph();
    const needle = q.toLowerCase();

    return all.filter((e) => {
      const haystack =
        e.label.toLowerCase() + ' ' + JSON.stringify(e.properties).toLowerCase();
      if (!haystack.includes(needle)) return false;

      if (type !== undefined && e.type !== type) return false;

      if (unconfirmedOnly === true) {
        return e.confirmed === false && e.superseded_by === null;
      }
      // Default: active records only.
      return e.superseded_by === null && e.valid_until === null;
    });
  }

  // Async vector/hybrid path. Each arm carries its OWN guard, so this promise NEVER
  // rejects (the 45f16fe never-reject guarantee, split per arm for the ratified
  // FTS-fallback contract):
  //   - vector arm → [] on ANY degrade: empty/whitespace q (no embed call), extension or
  //     embedder unavailable (silent), embed/KNN/graph-fold throw (logged).
  //   - hybrid → the fts-arm list (truncated to ENTITY_SEARCH_LIMIT) whenever the vector
  //     arm degrades or has no hits (FTS-fallback, NOT []); [] with a log line only if
  //     the fts arm ITSELF throws.
  return (async (): Promise<EntityRecord[]> => {
    // ── Vector arm ──
    let vectorHits: EntityRecord[] = [];
    if (q.trim() !== '' && vecAvailable() && embeddingEnabled()) {
      try {
        // Uniform over-fetch rule (W3): k = min(limit*4, 256) with limit = ENTITY_SEARCH_LIMIT
        // (→ 200); post-KNN active/confirmed/type filters can drop hits (EC 4/EC 6).
        const k = Math.min(ENTITY_SEARCH_LIMIT * 4, 256);
        const f32 = await embed(q); // EC 1: embedder init failure → caught below
        const hits = vecKnn(getDb(), 'entity_vec', f32, k);
        if (hits.length > 0) {
          // Resolve entity ids against the in-memory graph (EC 4: skip unresolvable ids).
          // entity_vec keys are TEXT cuid2 ids — no BigInt on this path.
          const all = loadGraph();
          const byId = new Map(all.map((e) => [e.id, e]));
          vectorHits = hits
            .map((h) => byId.get(h.id as string))
            .filter((e): e is EntityRecord => e !== undefined)
            // Same active/filter logic as the fts arm.
            .filter((e) => {
              if (type !== undefined && e.type !== type) return false;
              if (unconfirmedOnly === true) {
                return e.confirmed === false && e.superseded_by === null;
              }
              return e.superseded_by === null && e.valid_until === null;
            })
            .slice(0, ENTITY_SEARCH_LIMIT);
        }
      } catch (err) {
        console.error('[MOT/graph] searchEntities vector arm degraded to []:', err);
        vectorHits = [];
      }
    }

    if (mode === 'vector') return vectorHits;

    // ── Hybrid: fts arm under its own guard ──
    let ftsResults: EntityRecord[];
    try {
      ftsResults = searchEntities(q, type, unconfirmedOnly); // binds sync overload
    } catch (err) {
      console.error('[MOT/graph] searchEntities hybrid fts arm degraded to []:', err);
      return [];
    }

    // FTS-fallback: a degraded/empty vector arm yields the mode:'fts' result, truncated
    // to the entity path's one limit (the sync arm is uncapped; hybrid output is bounded).
    if (vectorHits.length === 0) return ftsResults.slice(0, ENTITY_SEARCH_LIMIT);

    // Both arms live: merge via RRF (FR 14).
    return rrfMerge<EntityRecord>([ftsResults, vectorHits], { limit: ENTITY_SEARCH_LIMIT });
  })();
}

/**
 * BFS traversal from `id` following properties.relations[].target_id edges (FR 9).
 *   - hops clamped to max 3 (EC-3); cycle-safe via a visited Set (EC-3).
 *   - rel: when given, only follow edges whose `rel` matches.
 *   - within each hop, neighbours are sorted by confidence DESC.
 *   - total result set capped at 50 entities (AC-6).
 * Returns the collected entities (the starting entity is NOT included), or [] if `id`
 * is not in the graph.
 */
export function relatedEntities(id: string, rel?: string, hops = 1): EntityRecord[] {
  const all = loadGraph();
  const byId = new Map(all.map((e) => [e.id, e]));
  if (!byId.has(id)) return [];

  const maxHops = Math.min(hops, 3);
  const visited = new Set<string>([id]);
  const result: EntityRecord[] = [];

  let frontier: EntityRecord[] = [byId.get(id)!];

  for (let hop = 0; hop < maxHops; hop++) {
    const nextById = new Map<string, EntityRecord>();

    for (const node of frontier) {
      const edges = node.properties.relations ?? [];
      for (const edge of edges) {
        if (rel !== undefined && edge.rel !== rel) continue;
        if (visited.has(edge.target_id)) continue;
        const target = byId.get(edge.target_id);
        if (!target) continue; // edge to a missing/compacted node
        nextById.set(target.id, target);
      }
    }

    // Sort this hop's newly-reached neighbours by confidence DESC before recording them.
    const nextNodes = [...nextById.values()].sort((a, b) => b.confidence - a.confidence);

    for (const node of nextNodes) {
      if (visited.has(node.id)) continue; // a closer hop already claimed it
      visited.add(node.id);
      result.push(node);
      if (result.length >= 50) return result; // AC-6 cap
    }

    frontier = nextNodes;
    if (frontier.length === 0) break;
  }

  return result;
}
