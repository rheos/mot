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
 * Internal helper — not exported. Tolerant of malformed lines (EC-1, AC-13): a line
 * that fails JSON.parse is logged and skipped, never thrown.
 */
function loadGraph(): EntityRecord[] {
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

/**
 * Keyword search over the graph (FR 7). Case-insensitive substring match against the
 * label and the serialized properties.
 *   - default: active records only (superseded_by === null && valid_until === null) — AC-5
 *   - unconfirmedOnly: confirmed === false && superseded_by === null — AC-5
 *   - type: additionally filter by entity type.
 */
export function searchEntities(
  q: string,
  type?: EntityRecord['type'],
  unconfirmedOnly?: boolean,
): EntityRecord[] {
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
