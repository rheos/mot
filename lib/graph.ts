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
    // OQ-A (Track 6): `confirmed` is carried on each edge so the BFS can PREFER confirmed edges
    // (ambient model — unconfirmed edges are still followed, confirmed ones merely sort first)
    // and the browser can show a Confirm button without a second return channel. The fold
    // (attachRelations) rebuilds this array wholesale from relate patches — any value stored
    // inline on an entity record is ignored (W3).
    relations?: { rel: string; target_id: string; confirmed: boolean }[];
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

// ── Track 6: entity graph edges ───────────────────────────────────────────────
// Three more JSONL shapes on the same append-only file, keyed on the (from, rel, to)
// natural key (OQ-2). `relate` establishes/refreshes a directed edge; `confirm_relate`
// is a human affirmation; `unrelate` is a human reject (expiry). resolveEdges folds all
// three into each entity's effective properties.relations[] (FR4–FR8).
export interface RelatePatch {
  op: 'relate';
  from: string;           // entity cuid2 id
  rel: string;            // member of REL_VOCABULARY
  to: string;             // entity cuid2 id
  confidence: number;
  source: string;         // "session:<id>" | "manual"
  valid_from: string;     // ISO datetime
  valid_until: string | null;
  confirmed: boolean;
  ts: string;
}
export interface ConfirmRelatePatch {
  op: 'confirm_relate';
  from: string; rel: string; to: string; ts: string;
}
export interface UnrelatePatch {
  op: 'unrelate';
  from: string; rel: string; to: string; ts: string;
}

// The closed relation vocabulary (OQ-3): 10 verbs, each with a fixed subject→object
// direction (see EXTRACTION_PROMPT_GUIDANCE). Widening later = append to this const.
export const REL_VOCABULARY = [
  'child_of', 'works_on', 'deadline_for', 'prefers', 'attends', 'belongs_to',
  'owns', 'hosted_on', 'points_to', 'depends_on',
] as const;
export type RelType = typeof REL_VOCABULARY[number];
export function isRelType(s: string): s is RelType {
  return (REL_VOCABULARY as readonly string[]).includes(s);
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
 * Append a FULL entity record VERBATIM, keeping its existing `id` (Track 9 dedup property union).
 *
 * Unlike appendEntity (which mints a fresh id), this re-writes an existing entity in place: loadGraph
 * folds records by id last-write-wins (`entities.set(rec.id, rec)`), so a later same-id line overrides
 * the earlier one on read. Used by the dedup worker to persist the survivor's unioned properties after
 * a merge — the append-only equivalent of the cleanup-entities atomic rewrite's in-place mutation.
 * The caller strips properties.relations first (edges are re-folded from patches at read time).
 * Fires the same fire-and-forget vec re-index as appendEntity (the label/properties text changed).
 */
export function appendEntityRecord(rec: EntityRecord): void {
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  indexAsync(getDb(), 'entity_vec', rec.id, rec.label + ' ' + JSON.stringify(rec.properties));
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

/**
 * Append a `relate` patch establishing/refreshing a directed edge (FR5). Single-syscall
 * append, mirroring appendEntity/appendSupersede. `valid_from = nowIso()`, `valid_until`
 * is ALWAYS null on write — expiry is expressed only by an `unrelate` op, never by writing
 * a pre-expired relate (the fold owns liveness). Does NOT touch entity_vec (edges aren't
 * embedded — Track-5 synergy is out of scope). Returns the patch.
 */
export function appendRelate(
  from: string,
  rel: string,
  to: string,
  confidence: number,
  source: string,
  confirmed: boolean,
): RelatePatch {
  const now = nowIso();
  const patch: RelatePatch = {
    op: 'relate',
    from,
    rel,
    to,
    confidence,
    source,
    valid_from: now,
    valid_until: null,
    confirmed,
    ts: now,
  };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(patch) + '\n');
  return patch;
}

/** Append a `confirm_relate` patch — a human affirmation of the edge (FR12). */
export function appendConfirmRelate(from: string, rel: string, to: string): void {
  const patch: ConfirmRelatePatch = { op: 'confirm_relate', from, rel, to, ts: nowIso() };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(patch) + '\n');
}

/** Append an `unrelate` patch — a human reject / expiry of the edge (FR16). */
export function appendUnrelate(from: string, rel: string, to: string): void {
  const patch: UnrelatePatch = { op: 'unrelate', from, rel, to, ts: nowIso() };
  const file = graphPath();
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(patch) + '\n');
}

/**
 * Write a pre-folded `relate` line VERBATIM to graph.jsonl (Track 9, EC-5/B1).
 *
 * Unlike appendRelate (which force-writes valid_until:null — the fold owns liveness, so it can
 * never express an expired edge), this carries the patch's valid_until and confirmed fields AS-IS.
 * It exists for the dedup edge re-point: after a merge, each affected (from,rel,to) triple is folded
 * (resolveEdge/resolveEdges) into ONE resolved patch carrying the true folded valid_until (the
 * unrelate ts if a human rejected it) and confirmed (the latched value), then re-pointed onto the
 * survivor. Direct-writing that one resolved relate preserves a human's unrelate/confirm_relate
 * across the merge — an orphan unrelate on the survivor triple would be dropped by resolveEdges's
 * no-base-relate rule, and appendRelate can't write an expired edge.
 *
 * The caller is responsible for folding + re-pointing FIRST (via resolveEdge + computeRepointedEdges
 * in lib/maintainer). Lives here (not in maintainer) because graphPath()/ensureDir() are file-private
 * and this belongs beside the other append writers (reuse invariant — the maintainer must not
 * reimplement the append path). Does NOT touch entity_vec (edges aren't embedded).
 */
export function appendResolvedRelate(patch: RelatePatch): void {
  const file = graphPath();
  ensureDir(file);
  // { ...patch, op:'relate' } — the patch already carries op:'relate'; spread-then-set is the same
  // serialized line and avoids the TS2783 duplicate-key warning.
  fs.appendFileSync(file, JSON.stringify({ ...patch, op: 'relate' }) + '\n');
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

// Track 6 edge patch discriminators — same shape as isSupersedePatch / isConfirmPatch.
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
 * The one shared edge-semantics fold (FR6, the correctness core of Track 6). Groups every
 * patch by its (from, rel, to) natural key and, for each triple with ≥1 `relate`, runs a
 * SINGLE `ts`-ordered fold over relate + confirm_relate + unrelate with these per-field
 * merge rules:
 *   - `confirmed` — a ONE-WAY LATCH. Starts false; set true by any `confirm_relate` OR any
 *     `relate` whose own `confirmed === true` (a manual entity_relate or a compacted-confirmed
 *     edge line). Once true, NEVER cleared by a later automated `relate(confirmed:false)`.
 *   - liveness (`valid_until`) — HUMAN-AUTHORITATIVE. Track expiredAt (starts null): `unrelate`
 *     sets it to the patch ts (human reject); a `confirm_relate`, or a LIVE `relate` with
 *     confirmed:true AND valid_until:null, clears it to null; an automated
 *     `relate(confirmed:false, valid_until:null)` never touches it. A PRE-EXPIRED `relate`
 *     (valid_until non-null — only appendResolvedRelate writes these, for the Track 9 edge
 *     re-point) sets expiredAt to its own valid_until, and its valid_until WINS regardless of
 *     `confirmed` — a confirmed-then-rejected edge (relate → confirm_relate → unrelate) folds to
 *     confirmed:true + expired, and the re-point must preserve the rejection, not resurrect it live.
 *   - `confidence` / `source` / `valid_from` / `ts` — last-write from the highest-`ts` `relate`.
 * A triple seen only in a confirm_relate/unrelate with no establishing relate is dropped
 * (no base to attach to). Returns one resolved patch per triple, BOTH live (valid_until:null)
 * and expired — callers filter on valid_until.
 */
export function resolveEdges(
  relates: RelatePatch[],
  confirmRelates: ConfirmRelatePatch[],
  unrelates: UnrelatePatch[],
): RelatePatch[] {
  const tripleKey = (from: string, rel: string, to: string): string =>
    `${from}|${rel}|${to}`;

  type StreamEvent =
    | { kind: 'relate'; ts: string; patch: RelatePatch }
    | { kind: 'confirm_relate'; ts: string }
    | { kind: 'unrelate'; ts: string };
  interface Group {
    from: string;
    rel: string;
    to: string;
    hasRelate: boolean;
    stream: StreamEvent[];
  }

  const groups = new Map<string, Group>();
  const groupFor = (from: string, rel: string, to: string): Group => {
    const k = tripleKey(from, rel, to);
    let g = groups.get(k);
    if (!g) {
      g = { from, rel, to, hasRelate: false, stream: [] };
      groups.set(k, g);
    }
    return g;
  };

  // Insertion order: relates, then confirm_relates, then unrelates. A stable sort by `ts`
  // preserves this on equal-`ts` ties (file order within a type; relate→confirm→unrelate
  // across types).
  for (const p of relates) {
    const g = groupFor(p.from, p.rel, p.to);
    g.hasRelate = true;
    g.stream.push({ kind: 'relate', ts: p.ts, patch: p });
  }
  for (const p of confirmRelates) {
    groupFor(p.from, p.rel, p.to).stream.push({ kind: 'confirm_relate', ts: p.ts });
  }
  for (const p of unrelates) {
    groupFor(p.from, p.rel, p.to).stream.push({ kind: 'unrelate', ts: p.ts });
  }

  const resolved: RelatePatch[] = [];
  for (const g of groups.values()) {
    if (!g.hasRelate) continue; // no base relate → the triple never existed

    // Array.prototype.sort is stable (ES2019+), so equal-`ts` events keep insertion order.
    const stream = [...g.stream].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    let confirmed = false; // one-way latch
    let expiredAt: string | null = null; // liveness — moved only by human actions
    // Candidate fields, last-write-by-`ts` from the highest-`ts` relate.
    let confidence = 0;
    let source = '';
    let validFrom = '';
    let latestTs = '';

    for (const ev of stream) {
      if (ev.kind === 'relate') {
        const r = ev.patch;
        confidence = r.confidence;
        source = r.source;
        validFrom = r.valid_from;
        latestTs = r.ts;
        if (r.valid_until !== null) {
          // A PRE-EXPIRED relate line (Track 9 appendResolvedRelate — the dedup edge re-point folds a
          // human unrelate into one resolved relate carrying the expiry verbatim). appendRelate always
          // writes valid_until:null, so ONLY a resolved-relate line reaches this branch. Honour it: the
          // fold reads liveness off the relate itself, so the survivor edge folds back EXPIRED without a
          // companion unrelate (which would be dropped for lacking a base relate on the survivor triple).
          // A resolved relate can be BOTH confirmed:true AND expired (a confirmed-then-rejected edge:
          // relate → confirm_relate → unrelate folds to confirmed:true, valid_until=unrelate.ts). Its own
          // valid_until MUST win regardless of confirmed, else the re-point resurrects a rejected edge
          // LIVE and the human's rejection is lost (EC-5 confirmed+rejected case).
          expiredAt = r.valid_until;
          if (r.confirmed === true) confirmed = true; // still latch confirmed
        } else if (r.confirmed === true) {
          confirmed = true; // human affirmation via manual / compacted-confirmed relate
          expiredAt = null; // a live confirmed relate re-asserts liveness
        }
        // an automated relate(confirmed:false, valid_until:null) refreshes candidate fields only
      } else if (ev.kind === 'confirm_relate') {
        confirmed = true; // latch
        expiredAt = null; // human re-asserts liveness
      } else {
        expiredAt = ev.ts; // unrelate — human reject
      }
    }

    resolved.push({
      op: 'relate',
      from: g.from,
      rel: g.rel,
      to: g.to,
      confidence,
      source,
      valid_from: validFrom,
      valid_until: expiredAt,
      confirmed,
      ts: latestTs,
    });
  }

  return resolved;
}

/**
 * Rebuild each entity's effective properties.relations[] from resolved edges (FR6, W3).
 * FIRST clears properties.relations = [] on EVERY entity in the map (wholesale replace — any
 * stale value stored inline on an entity record is dropped, so it can never leak a phantom
 * edge that renders a Confirm button which can never stick). THEN pushes each LIVE edge
 * (valid_until === null) whose `from` is present in the map onto that entity's array.
 * Unknown `from` is a no-op (EC6); an unknown `to` is kept as a dangling target, but a `to`
 * that resolves to a SUPERSEDED/merged-away node is skipped (W2 defense-in-depth — see below).
 */
export function attachRelations(entities: Map<string, EntityRecord>, edges: RelatePatch[]): void {
  for (const e of entities.values()) {
    e.properties.relations = [];
  }
  for (const edge of edges) {
    if (edge.valid_until !== null) continue; // expired edges don't surface
    const from = entities.get(edge.from);
    if (!from) continue; // unknown from (EC6) — no-op
    if (from.superseded_by !== null) continue; // merged-away/superseded from — its stale edges don't
    // surface (Track 9: after a dedup merge, the merged-away node's original edges are re-pointed to
    // the survivor via appendResolvedRelate; the source node's own line stops contributing so the
    // edge isn't double-counted from both the dead node and the survivor).
    // W2 (Track 9 defense-in-depth): symmetric guard on the TARGET. If `to` resolves to a KNOWN but
    // superseded/merged-away node, skip the edge — a stale-target edge that somehow survived the
    // dedup re-point (e.g. a cross-group loser edge left dangling) must never surface as a phantom
    // neighbour. An UNKNOWN `to` (not in the map) is still kept as a dangling target (unchanged).
    const to = entities.get(edge.to);
    if (to && to.superseded_by !== null) continue;
    const rels = from.properties.relations ?? (from.properties.relations = []);
    rels.push({ rel: edge.rel, target_id: edge.to, confirmed: edge.confirmed });
  }
}

/**
 * Single-triple resolver shared by confirmRelate / rejectRelate (and the browser route).
 * Reads the live JSONL, collects every patch for the one (from, rel, to) triple, folds via
 * resolveEdges, and returns the resolved patch (live OR expired) or null if the triple has
 * no `relate` patch.
 */
export function resolveEdge(from: string, rel: string, to: string): RelatePatch | null {
  const file = graphPath();
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, 'utf8');
  const relates: RelatePatch[] = [];
  const confirmRelates: ConfirmRelatePatch[] = [];
  const unrelates: UnrelatePatch[] = [];

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRelatePatch(parsed) && parsed.from === from && parsed.rel === rel && parsed.to === to) {
      relates.push(parsed);
    } else if (
      isConfirmRelatePatch(parsed) && parsed.from === from && parsed.rel === rel && parsed.to === to
    ) {
      confirmRelates.push(parsed);
    } else if (
      isUnrelatePatch(parsed) && parsed.from === from && parsed.rel === rel && parsed.to === to
    ) {
      unrelates.push(parsed);
    }
  }

  return resolveEdges(relates, confirmRelates, unrelates)[0] ?? null;
}

/**
 * Confirm an unconfirmed candidate edge (FR12). Typed-result, never throws (AC-12).
 * not_found → the triple has no relate patch; already_confirmed → EC8.
 */
export function confirmRelate(
  from: string,
  rel: string,
  to: string,
): RelatePatch | { error: string } {
  const e = resolveEdge(from, rel, to);
  if (!e) return { error: 'not_found' };
  if (e.confirmed === true) return { error: 'already_confirmed' };
  appendConfirmRelate(from, rel, to);
  // The relate patch still exists, so the re-resolve is guaranteed non-null.
  return resolveEdge(from, rel, to)!;
}

/**
 * Reject (expire) a candidate edge (FR16 / W4). Typed-result, never throws (AC-12).
 * not_found → the triple has no relate patch; already_rejected → the edge is already expired.
 */
export function rejectRelate(
  from: string,
  rel: string,
  to: string,
): RelatePatch | { error: string } {
  const e = resolveEdge(from, rel, to);
  if (!e) return { error: 'not_found' };
  if (e.valid_until !== null) return { error: 'already_rejected' };
  appendUnrelate(from, rel, to);
  // The relate patch still exists, so the re-resolve is guaranteed non-null.
  return resolveEdge(from, rel, to)!;
}

/**
 * Confirm a candidate entity (Track 2). Typed-result, never throws — mirrors the
 * confirmRelate/confirmNote pattern so the pre-checks live in ONE place, shared by the
 * `entity_confirm` MCP tool AND POST /api/memory/entities/confirm (the browser Confirm button).
 * not_found → missing OR superseded (a superseded/pruned entity is not confirmable in place,
 * EC-1); already_confirmed → the entity is already confirmed. On success, appends the confirm
 * patch and returns the updated record.
 */
export function confirmEntity(id: string): EntityRecord | { error: string } {
  const existing = getEntity(id);
  if (existing === null) return { error: 'not_found' };
  if (existing.record.superseded_by !== null) return { error: 'not_found' };
  if (existing.record.confirmed === true) return { error: 'already_confirmed' };
  appendEntityConfirm(id);
  const updated = getEntity(id);
  return updated?.record ?? { error: 'not_found' };
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
  const relateBucket: RelatePatch[] = [];
  const confirmRelateBucket: ConfirmRelatePatch[] = [];
  const unrelateBucket: UnrelatePatch[] = [];

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
    } else if (isRelatePatch(parsed)) {
      relateBucket.push(parsed);
    } else if (isConfirmRelatePatch(parsed)) {
      confirmRelateBucket.push(parsed);
    } else if (isUnrelatePatch(parsed)) {
      unrelateBucket.push(parsed);
    } else {
      // An id-less patch line MUST NOT reach here — it would set a garbage `undefined` key.
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

  // Fold relate patches (Track 6): rebuild every entity's effective properties.relations[]
  // from the resolved edges. Wholesale replace — inline values on entity records are ignored.
  const resolvedEdges = resolveEdges(relateBucket, confirmRelateBucket, unrelateBucket);
  attachRelations(entities, resolvedEdges);

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
 * BFS traversal from `id` following properties.relations[] edges in BOTH directions (FR 9).
 * "Related" means connected EITHER way: the traversal follows a node's OUTBOUND edges (its own
 * relations[].target_id) AND its INBOUND edges (every other active entity whose relations[]
 * point at this node). This surfaces a canonical node's inbound members too — e.g. the Track 9
 * resolution worker links member Facts to a canonical node with a Fact→canonical `points_to`
 * edge, so those Facts are inbound to the canonical node and must count as related.
 *   - hops clamped to max 3 (EC-3); cycle-safe via a visited Set (EC-3).
 *   - rel: when given, only follow edges whose `rel` matches — in EITHER direction.
 *   - unconfirmed edges ARE followed (ambient model); confirmed-reached neighbours sort first,
 *     then by entity confidence DESC (applied to inbound-reached neighbours too).
 *   - total result set capped at 50 entities (AC-6).
 * Returns the collected entities (the starting entity is NOT included), or [] if `id`
 * is not in the graph.
 */
export function relatedEntities(id: string, rel?: string, hops = 1): EntityRecord[] {
  const all = loadGraph();
  const byId = new Map(all.map((e) => [e.id, e]));
  if (!byId.has(id)) return [];

  // Reverse index, built ONCE per call: target_id → the edges pointing AT it. Lets the inbound
  // arm of each frontier node be an O(1) lookup instead of rescanning the whole graph per node.
  const inboundBySource = new Map<
    string,
    { sourceId: string; rel: string; confirmed: boolean }[]
  >();
  for (const e of all) {
    for (const edge of e.properties.relations ?? []) {
      const bucket = inboundBySource.get(edge.target_id);
      const entry = { sourceId: e.id, rel: edge.rel, confirmed: edge.confirmed };
      if (bucket) bucket.push(entry);
      else inboundBySource.set(edge.target_id, [entry]);
    }
  }

  const maxHops = Math.min(hops, 3);
  const visited = new Set<string>([id]);
  const result: EntityRecord[] = [];

  let frontier: EntityRecord[] = [byId.get(id)!];

  for (let hop = 0; hop < maxHops; hop++) {
    // Ambient model (ratified 2026-07-08): memory is used BY DEFAULT, and confirmation is a
    // correction surface, not a gate. So the BFS FOLLOWS unconfirmed edges too — it does not
    // drop them (the old FR7 confirmed-only skip is gone). Confirmed edges are merely PREFERRED:
    // track whether each neighbour was reached by a confirmed edge so the hop can sort them first.
    const nextById = new Map<string, { node: EntityRecord; confirmed: boolean }>();

    // One neighbour-consider step, shared by the outbound and inbound arms: same rel filter,
    // visited skip, missing-node skip, and confirmed-upgrade logic in both directions.
    const consider = (neighbourId: string, edgeRel: string, edgeConfirmed: boolean): void => {
      if (rel !== undefined && edgeRel !== rel) return;
      if (visited.has(neighbourId)) return;
      const target = byId.get(neighbourId);
      if (!target) return; // edge to a missing/compacted node
      const prev = nextById.get(target.id);
      // Keep the strongest reaching-edge: a confirmed edge upgrades a prior unconfirmed reach.
      if (!prev || (edgeConfirmed === true && !prev.confirmed)) {
        nextById.set(target.id, { node: target, confirmed: edgeConfirmed === true });
      }
    };

    for (const node of frontier) {
      // OUTBOUND: the node's own relations[] (as before).
      for (const edge of node.properties.relations ?? []) {
        consider(edge.target_id, edge.rel, edge.confirmed === true);
      }
      // INBOUND: every other active entity whose relations[] point AT this node.
      for (const inEdge of inboundBySource.get(node.id) ?? []) {
        consider(inEdge.sourceId, inEdge.rel, inEdge.confirmed === true);
      }
    }

    // Sort this hop's neighbours: confirmed-reached first, then entity confidence DESC.
    const nextNodes = [...nextById.values()]
      .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.node.confidence - a.node.confidence)
      .map((x) => x.node);

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
