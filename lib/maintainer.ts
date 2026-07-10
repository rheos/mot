// Track 9 — The Maintainer. The nightly memory-upkeep workers (Taylor's "Inside Out
// mind-workers"): they ORGANIZE and CONNECT memory but NEVER forget it. Every mutation is
// additive/reversible; a Fact is never superseded, deleted, or rewritten by a worker.
//
// The hard invariant (spec § "The LLM-identify / deterministic-execute boundary"): the LLM
// ONLY returns identifications keyed by entity id — it never emits a graph mutation. Deterministic
// TypeScript reads those ids, re-validates each against a FRESH loadGraph(), gates at
// confidence ≥ 0.85, and performs every appendEntity/appendRelate/appendSupersede itself. An
// inaccurate LLM count can cause a false skip or a spurious (confirmed:false, reversible) edge —
// accepted quality-vs-complexity tradeoff — but the LLM can never delete or supersede a good memory.
//
// Phase 2 (this file, so far): Worker 1 — entity resolution / canonicalization. It reads the
// active entities, asks claude -p "which of these describe the same real-world named thing", mints
// a canonical named node (confirmed:false, source:'maintainer:resolution') for each recurring
// subject that clears the type-specific mint threshold, and links the descriptive Fact entities to
// it with candidate `points_to` edges — reusing linkRelationDraft's ONE resolve-or-create impl.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { linkRelationDraft, type LinkResult } from '../scripts/backfill-relations';
import {
  appendEntityRecord,
  appendResolvedRelate,
  appendSupersede,
  loadGraph,
  resolveEdge,
  type EntityRecord,
  type RelatePatch,
} from './graph';
import type { BotRelationDraftItem } from './extraction';

// ── The shared LLM helper ──────────────────────────────────────────────────────
// Lifted verbatim from scripts/backfill-relations.ts's extractRelationDraft spawn+parse block so
// there is EXACTLY ONE copy of the `claude -p` + balanced-brace JSON-extraction logic in the repo
// (backfill-relations.ts's extractRelationDraft now CALLS this instead of duplicating it). It does
// NOT build a prompt — the caller owns the prompt; this just runs it and returns the first balanced
// JSON object, or null when the output has no `{`. A non-zero exit throws (the caller's per-batch
// try/catch turns that into batches_failed — EC-3).
export function identifyViaClaude(prompt: string): unknown {
  const res = spawnSync(
    'claude',
    ['-p', prompt, '--model', 'claude-sonnet-4-6', '--allowedTools', ''],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`claude -p exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`);
  }
  const raw = (res.stdout || '').trim();
  const clean = raw.replace(/^```json\s*|^```\s*|\s*```$/gm, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return JSON.parse(clean.slice(start, end));
}

// ── Worker 1: entity resolution ────────────────────────────────────────────────

// FR-5/OQ-3 — how many DISTINCT source entities must describe a named thing before the worker mints
// a canonical node for it. Person is a low bar (2); Project/Fact are stricter (3). Deadline and
// Preference are inherently one-shot — they arrive as Facts/relations, not canonical hubs — so they
// are NEVER minted (Infinity, unreachable). The gate is on the MINT decision only: if the LLM found
// an existing_representative_id, the worker links to it regardless of the count.
const MINT_THRESHOLDS: Record<string, number> = {
  Person: 2,
  Project: 3,
  Fact: 3,
  Deadline: Infinity, // never minted
  Preference: Infinity, // never minted
};

// The identification shape the LLM returns per real-world named thing (FR-1). It is keyed by entity
// id ONLY — no mutations, no JSONL. Deterministic TS re-validates every id against a fresh graph.
interface IdentificationItem {
  canonical_label: string;
  canonical_type: EntityRecord['type'];
  existing_representative_id: string | null;
  member_entity_ids: string[];
  distinct_source_count: number;
  confidence: number;
  reason: string;
}

// The resolution worker's run summary (the `resolution` sub-object of MaintainerStatus — the status
// file + MCP tools land in Phase 4; the shape is fixed here so callers can already consume it).
export interface ResolutionStatus {
  last_run: string;
  ok: boolean;
  named_nodes_minted: number;
  edges_linked: number;
  batches_failed: number;
  error: string | null;
}

// A-6 — the conservative identification prompt, styled after EXTRACTION_PROMPT_GUIDANCE (explicit,
// no-inference, confidence-gated at 0.85, structured JSON out). The LLM returns identifications keyed
// by entity id; it never emits a mutation. The full active-entity JSON is appended by the caller.
export const RESOLUTION_PROMPT = `
You are canonicalizing an append-only entity memory graph. You are given a JSON array of ENTITIES
(each: { id, type, label, properties, confidence }). Many are descriptive Fact "sentences" about the
same real-world named thing (e.g. several facts that all describe the person "Taylor", or the project
"SampleApp") with no single canonical named node for that thing yet.

Your job: identify which entities describe the SAME real-world NAMED thing, and for each such thing
return one identification. Return ONLY a JSON object of the exact shape:

  { "identifications": [
    { "canonical_label": string,
      "canonical_type": "Person" | "Project" | "Deadline" | "Preference" | "Fact",
      "existing_representative_id": string | null,
      "member_entity_ids": string[],
      "distinct_source_count": number,
      "confidence": number,
      "reason": string } ] }

RULES:
- Identify ONLY named things that are EXPLICITLY present in the input entities. Do NOT infer, invent,
  or extrapolate a subject that is not described by the entities you were given.
- canonical_label is the clean canonical name of the thing (e.g. "Taylor", "SampleApp"), not a sentence.
- canonical_type is the entity type of the canonical named node: a person → "Person"; an app / site /
  service / code repo Taylor builds, runs, or owns → "Project"; hosts / boxes / domains / accounts and
  other passive infrastructure → "Fact"; schedule items → "Deadline"; stated preferences → "Preference".
- existing_representative_id: if the input ALREADY contains a canonical named node for this thing — an
  entity whose type is canonical_type and whose label EXACTLY matches canonical_label — return its id.
  Otherwise return null. (The descriptive Fact sentences are NOT representatives; only an already-clean
  named node is.)
- member_entity_ids: the ids of the input entities that describe this named thing (the descriptive
  Facts, plus the representative if one exists). Use the ids from the input verbatim.
- distinct_source_count: how many DISTINCT input entity ids in member_entity_ids describe this named
  thing. This is the count of describing entities, NOT the total number of entities in the input. It
  gates whether a new canonical node is minted, so count carefully.
- confidence (0.0–1.0): how DIRECTLY and unambiguously the entities converge on this single named
  thing. An identification with confidence < 0.85 will be dropped — OMIT any identification you are not
  at least 0.85 confident in.
- reason: one sentence naming the evidence.
- Populate every field on every identification. Do not emit prose or markdown fences — JSON only.
`.trim();

/**
 * Worker 1 — entity resolution / canonicalization.
 *
 * `identify` is a dependency-injection seam: it defaults to the real `identifyViaClaude` (a live
 * `claude -p` spawn) in production; tests pass a stub returning canned identifications so NO test
 * ever spawns a real model. All LLM access in the body goes through `identify`, never the
 * module-level function directly.
 *
 * Single-batch send: the entire active-entity list (~138 entities) is one `identify` call. Batching
 * is a deliberate v2 concern — at this scale one batch is simpler and correct.
 */
export function resolutionWorker({
  dryRun,
  identify = identifyViaClaude,
}: {
  dryRun: boolean;
  identify?: (prompt: string) => unknown;
}): ResolutionStatus {
  const status: ResolutionStatus = {
    last_run: new Date().toISOString(),
    ok: true,
    named_nodes_minted: 0,
    edges_linked: 0,
    batches_failed: 0,
    error: null,
  };

  // 1. Active entities only (superseded_by === null). This mutable array is the shared working
  //    `index` linkRelationDraft resolves against and pushes minted nodes into (EC-2/EC-6): a node
  //    minted for one identification resolves for a later one in the same pass, and an exact-label
  //    node already present is reused, never re-minted.
  const actives = loadGraph().filter((e) => e.superseded_by === null);
  const index: EntityRecord[] = actives;

  // 2. B3 cross-run edge idempotency — seed seenEdges from the PERSISTED live triples, not just this
  //    run's in-memory set. Walk every active entity's folded properties.relations[] (the live,
  //    non-expired edges attachRelations produced) and add the identical `${from}|${rel}|${to}` key
  //    linkRelationDraft checks (backfill-relations.ts). A second nightly pass over an unchanged graph
  //    then sees every persisted points_to edge as already-seen and appends ZERO new JSONL lines.
  const seenEdges = new Set<string>();
  for (const e of actives) {
    for (const edge of e.properties.relations ?? []) {
      seenEdges.add(`${e.id}|${edge.rel}|${edge.target_id}`);
    }
  }

  // 3. LLM identify — the whole active list is one batch. EC-3: a failed batch logs, increments
  //    batches_failed, and returns the (empty) partial status; the graph is untouched (no write ran).
  let identifications: IdentificationItem[];
  try {
    const raw = identify(RESOLUTION_PROMPT + '\n\nENTITIES:\n' + JSON.stringify(actives));
    const parsed = (raw ?? {}) as { identifications?: IdentificationItem[] };
    identifications = Array.isArray(parsed.identifications) ? parsed.identifications : [];
  } catch (err) {
    console.error('[MOT/maintainer] resolution batch failed:', err);
    status.batches_failed += 1;
    status.ok = false;
    status.error = String(err);
    return status;
  }

  for (const ident of identifications) {
    // Gate at confidence ≥ 0.85 (the LLM-identify/deterministic-execute boundary).
    if (typeof ident.confidence !== 'number' || ident.confidence < 0.85) continue;

    // 3a. FR-5 mint-threshold gate. Skip a one-off subject ONLY when no canonical node already exists;
    //     if existing_representative_id is set, we still link to it (the gate is on minting, not linking).
    const threshold = MINT_THRESHOLDS[ident.canonical_type] ?? Infinity;
    if (ident.distinct_source_count < threshold && ident.existing_representative_id === null) {
      continue;
    }

    // 3b. EC-8 — re-validate member ids against a FRESH loadGraph() (the LLM ran against a snapshot;
    //     compaction or a concurrent write may have removed an id since). Drop any id not present now.
    const freshById = new Map(loadGraph().map((e) => [e.id, e]));

    // 3c. Build a synthetic BotRelationDraftItem[] — one points_to edge per member Fact → the canonical
    //     named node. Exclude the representative itself (don't link a node to itself). linkRelationDraft
    //     does the exact-label resolve-or-create of the canonical node and writes the candidate edges.
    const items: BotRelationDraftItem[] = [];
    for (const memberId of ident.member_entity_ids) {
      if (memberId === ident.existing_representative_id) continue; // never self-link the representative
      const member = freshById.get(memberId);
      if (!member) continue; // EC-8: stale id — skip and move on
      items.push({
        from_label: member.label,
        rel: 'points_to',
        to_label: ident.canonical_label,
        from_type: member.type,
        to_type: ident.canonical_type,
        confidence: ident.confidence,
      });
    }
    if (items.length === 0) continue;

    // 3d. ONE resolve-or-create implementation (backfill-relations.ts). source:'maintainer:resolution'
    //     tags both the minted canonical node and every candidate edge. create:true is the whole point —
    //     resolve-or-CREATE (never create:false here). dryRun short-circuits every write inside.
    const result: LinkResult = linkRelationDraft(JSON.stringify(items), 'maintainer:resolution', index, {
      dryRun,
      create: true,
      seenEdges,
    });
    status.named_nodes_minted += result.entitiesCreated.length;
    status.edges_linked += result.edgesWritten;
  }

  return status;
}

// ── Worker 2: dedup / merge ────────────────────────────────────────────────────
//
// Merges duplicate entities. The LLM only IDENTIFIES same-real-thing groups keyed by id; every
// write (survivor-select, property union, edge re-point, supersede) is deterministic TS. Two
// structural guarantees: (1) NEVER supersede a lone entity on an LLM boolean — single-entity retype
// is DEFERRED (B4), so a group needs ≥2 valid members; (2) NEVER drop a property value on a merge
// (FR-10 hard). The one real correctness fix is edge re-point (EC-5/B1): for every triple touching a
// merged-away id, fold it and DIRECT-WRITE one resolved relate on the survivor carrying the folded
// valid_until/confirmed verbatim — a human unrelate/confirm_relate survives the merge — dropping any
// re-point that collapses to a self-loop (B2).

// The resolve-or-default graph path — the SAME value loadGraph() resolves internally (lib/graph.ts
// graphPath()). Tests set MOT_GRAPH_PATH to a temp file; production leaves it unset and this returns
// the live ontology/graph.jsonl. Used for the backup snapshot and passed to repointEdges.
function resolveGraphFile(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

// The properties present on an entity, excluding the folded relations[] (edges are re-derived at
// read time — they are never a merge property). Mirrors cleanup-entities.ts:propCount.
function propCount(e: EntityRecord): number {
  const { relations: _r, ...rest } = e.properties ?? {};
  return Object.keys(rest).length;
}

/**
 * Select the canonical survivor of a duplicate group and additively union every merged-away
 * entity's properties into it (FR-8/FR-10). Lifted from scripts/cleanup-entities.ts:71-98 so the
 * script and the dedup worker share ONE merge core.
 *
 * Selection order (the cleanup-entities order): highest `confidence`, then most properties
 * (excluding `relations`), then earliest `valid_from`.
 *
 * Property union is ADDITIVE and canonical-wins: `{ ...dupProps, ...survivor.properties }` — the
 * survivor's value wins on a key conflict, but EVERY key from EVERY merged-away entity that the
 * survivor lacks is imported. No key is ever dropped (FR-10 is a hard invariant, not best-effort).
 * `relations` is excluded from the union (edges are re-folded from patches at read time).
 */
export function mergeGroup(members: EntityRecord[]): {
  survivor: EntityRecord;
  mergedAway: EntityRecord[];
} {
  // A stable copy so the caller's array order is not mutated.
  const sorted = [...members].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      propCount(b) - propCount(a) ||
      a.valid_from.localeCompare(b.valid_from),
  );
  const survivor = sorted[0];
  const mergedAway = sorted.slice(1);
  for (const dup of mergedAway) {
    const { relations: _r, ...dupProps } = dup.properties ?? {};
    // canonical (survivor) wins on key conflict; every other key is imported (FR-10 hard).
    survivor.properties = { ...dupProps, ...survivor.properties };
  }
  return { survivor, mergedAway };
}

/**
 * The single shared PURE fold/re-point/self-loop-drop core (EC-5/B1/B2). Given a set of
 * ALREADY-FOLDED live edges (each a resolved RelatePatch carrying its true valid_until/confirmed)
 * and a `mergedAwayId → survivorId` map, return the re-pointed resolved edge set. No file I/O.
 *
 * BOTH consumers delegate here so the fold/re-point/self-loop logic is never duplicated:
 *   - repointEdges (the worker's APPEND path) folds each triple then calls this, then
 *     appendResolvedRelate's each result;
 *   - scripts/cleanup-entities.ts (the atomic-REWRITE path) folds each triple then calls this to
 *     build its rewrite array.
 *
 * Per input patch: re-point from' = map.get(from) ?? from, to' = map.get(to) ?? to. If from' === to'
 * (a merged-away id had an edge to/from the survivor — re-pointing collapses it into a self-loop),
 * DROP the triple: it is excluded from the result and logged. A self-loop carries no information
 * (an entity related to itself), so dropping it is lossless (B2). Otherwise emit a new RelatePatch
 * with the re-pointed endpoints and ALL other fields (rel, confidence, source, valid_from,
 * valid_until, confirmed, ts) carried VERBATIM from the folded input.
 */
export function computeRepointedEdges(
  edges: RelatePatch[],
  mergedAwayMap: Map<string, string>,
): RelatePatch[] {
  const out: RelatePatch[] = [];
  for (const e of edges) {
    const from = mergedAwayMap.get(e.from) ?? e.from;
    const to = mergedAwayMap.get(e.to) ?? e.to;
    if (from === to) {
      // B2 self-loop: re-point collapsed the triple onto a single node — drop it (lossless).
      console.log(
        `[MOT/maintainer] dropped self-loop after re-point: ${e.from} -[${e.rel}]-> ${e.to} → ${from} (no relate line written)`,
      );
      continue;
    }
    out.push({ ...e, from, to });
  }
  return out;
}

/**
 * The APPEND path for the dedup worker's edge re-point (EC-5/B1/B2). For a single merge
 * (mergedAwayId → survivorId), collect every distinct (from, rel, to) triple in `graphFile` where
 * `from === mergedAwayId` OR `to === mergedAwayId`, fold each via resolveEdge (which folds all three
 * patch kinds — relate + confirm_relate + unrelate), pass the folded patches through the shared
 * computeRepointedEdges (re-point + self-loop drop), and appendResolvedRelate each survivor edge —
 * one JSONL line per surviving triple, carrying the folded valid_until/confirmed verbatim.
 *
 * A triple with no base `relate` folds to null (resolveEdge returns null) and is skipped: an orphan
 * confirm_relate/unrelate never established an edge, so there is nothing to re-point.
 *
 * `graphFile` MUST equal the value loadGraph() resolves (MOT_GRAPH_PATH or the ontology/ default);
 * the worker passes resolveGraphFile(), tests pass their temp path.
 */
export function repointEdges(mergedAwayId: string, survivorId: string, graphFile: string): void {
  if (!fs.existsSync(graphFile)) return;

  // Collect every DISTINCT (from, rel, to) triple that touches the merged-away id, across all three
  // patch kinds (a human unrelate/confirm_relate is keyed on the SAME natural key as its relate).
  const triples = new Set<string>();
  for (const line of fs.readFileSync(graphFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: { op?: string; from?: string; rel?: string; to?: string };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue; // skip malformed
    }
    if (
      (r.op === 'relate' || r.op === 'confirm_relate' || r.op === 'unrelate') &&
      r.from &&
      r.rel &&
      r.to &&
      (r.from === mergedAwayId || r.to === mergedAwayId)
    ) {
      triples.add(`${r.from}|${r.rel}|${r.to}`);
    }
  }

  const mergedAwayMap = new Map<string, string>([[mergedAwayId, survivorId]]);
  for (const key of triples) {
    const [from, rel, to] = key.split('|') as [string, string, string];
    const folded = resolveEdge(from, rel, to); // folds relate + confirm_relate + unrelate
    if (!folded) continue; // no base relate → nothing to re-point
    for (const edge of computeRepointedEdges([folded], mergedAwayMap)) {
      appendResolvedRelate(edge);
    }
  }
}

// ── The dedup identification (LLM boundary) ──────────────────────────────────────

// A merge group the LLM returns — keyed by entity id ONLY (no mutations, no is_retype field: B4).
interface DedupGroup {
  canonical_label: string;
  canonical_type: EntityRecord['type'];
  member_ids: string[];
  confidence: number;
  reason: string;
}

// The dedup worker's run summary (the `dedup` sub-object of MaintainerStatus — the status file +
// MCP tools land in Phase 4; the shape is fixed here so callers can already consume it). No
// entities_retyped field — single-entity retype is DEFERRED (B4).
export interface DedupStatus {
  last_run: string;
  ok: boolean;
  entities_merged: number;
  backup_path: string | null;
  batches_failed: number;
  error: string | null;
}

// A-6 — the conservative dedup prompt, styled after RESOLUTION_PROMPT / EXTRACTION_PROMPT_GUIDANCE.
// The LLM returns merge groups keyed by id; it never emits a mutation. There is NO is_retype field
// and NO single-entity path (B4). The full same-type entity JSON is appended by the caller.
export const DEDUP_PROMPT = `
You are deduplicating an append-only entity memory graph. You are given a JSON array of ENTITIES that
are ALL THE SAME TYPE (each: { id, type, label, properties, confidence }). Some describe the same
real-world thing under slightly different labels or with different property sets.

Your job: identify which entities are DUPLICATES — the same real-world thing — and group them. Return
ONLY a JSON object of the exact shape:

  { "groups": [
    { "canonical_label": string,
      "canonical_type": "Person" | "Project" | "Deadline" | "Preference" | "Fact",
      "member_ids": string[],
      "confidence": number,
      "reason": string } ] }

RULES:
- Group ONLY entities that are the SAME real-world thing. When in doubt, do NOT group — a false merge
  points two distinct memories at one node. Two different people who share a first name are NOT the
  same entity; two projects with similar names are NOT the same unless the properties confirm it.
- Every group MUST contain 2 OR MORE member_ids. A single-entity "group" is invalid and will be
  discarded — never return a group with one member_id (there is no single-entity retype or supersede;
  a wrong TYPE on a non-duplicate is corrected elsewhere, not here).
- member_ids: the ids of the input entities that are the same thing. Use the ids verbatim. Include
  the best canonical representative plus its duplicates.
- canonical_label / canonical_type: the clean canonical name and type of the merged thing.
- Base every judgment on the FULL property sets shown — explain in the reason field why they are the
  same real-world thing (the concrete evidence, one sentence).
- confidence (0.0–1.0): how certain you are these are the same thing. A group with confidence < 0.85
  will be dropped — OMIT any group you are not at least 0.85 confident in.
- Populate every field on every group. Do not emit prose or markdown fences — JSON only.
`.trim();

/**
 * Worker 2 — dedup / merge.
 *
 * `identify` is the same dependency-injection seam as resolutionWorker: it defaults to the real
 * `identifyViaClaude` in production; tests pass a stub returning canned merge groups so NO test ever
 * spawns a real `claude -p`. All LLM access in the body goes through `identify`.
 *
 * Sequence: own .bak snapshot (skipped in dry-run) → deterministic exact-(type,label) pre-merge pass
 * (no LLM, handles EC-6 concurrent-mint duplicates) → LLM dedup pass over the survivors (per-type
 * batches, each in its own try/catch — EC-3). Each merge: mergeGroup → repointEdges (per merged-away
 * id) → appendSupersede (skipping already-superseded — FR-19 idempotency). dryRun logs and writes
 * nothing.
 */
export function dedupWorker({
  dryRun,
  identify = identifyViaClaude,
}: {
  dryRun: boolean;
  identify?: (prompt: string) => unknown;
}): DedupStatus {
  const status: DedupStatus = {
    last_run: new Date().toISOString(),
    ok: true,
    entities_merged: 0,
    backup_path: null,
    batches_failed: 0,
    error: null,
  };

  // The SAME path loadGraph() resolves — used for the backup and passed to repointEdges.
  const graphFile = resolveGraphFile();

  // FR-9/EC-10 — the dedup worker takes its OWN timestamped .bak snapshot before any write,
  // independent of the nightly graph backup. Skipped ENTIRELY in dry-run (AC-9: no backup file).
  if (!dryRun && fs.existsSync(graphFile)) {
    const backup = `${graphFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(graphFile, backup);
    status.backup_path = backup;
  }

  // One merge of an already-selected member group: mergeGroup (survivor-select + additive property
  // union — FR-10) → per merged-away id { supersede (skip if already superseded — FR-19) +
  // repointEdges } → persist the survivor's unioned properties (append-only re-write, same id). In
  // dry-run, log only and touch nothing.
  const executeMerge = (members: EntityRecord[]): void => {
    const { survivor, mergedAway } = mergeGroup(members);
    let mergedAnyThisGroup = false;
    for (const dup of mergedAway) {
      // FR-19 idempotency — a re-run finds the loser already superseded and does not re-supersede.
      if (dup.superseded_by !== null) continue;
      if (dryRun) {
        console.log(
          `[MOT/maintainer] dedup (dry-run) would merge ${dup.type} "${dup.label}" (${dup.id}) → ${survivor.id}`,
        );
        continue;
      }
      appendSupersede(dup.id, survivor.id);
      repointEdges(dup.id, survivor.id, graphFile);
      status.entities_merged += 1;
      mergedAnyThisGroup = true;
    }
    // Persist the survivor's unioned properties (FR-10 — no property value lost). Append-only: a
    // fresh same-id record overrides on read (loadGraph last-write-wins by id). Only when a real
    // merge happened this group (dry-run and fully-idempotent re-runs write nothing).
    if (!dryRun && mergedAnyThisGroup) {
      const { relations: _r, ...props } = survivor.properties ?? {};
      appendEntityRecord({ ...survivor, properties: props });
    }
  };

  // 1. Deterministic exact-(type,label) pre-merge pass (W2/EC-6). NO LLM call — a concurrent-mint
  //    duplicate is exact by construction (same type, same trimmed-lowercased label). This handles
  //    the EC-6 race for free AND shrinks the batch the LLM sees to only the non-exact candidates.
  const actives = loadGraph().filter((e) => e.superseded_by === null);
  const exactGroups = new Map<string, EntityRecord[]>();
  for (const e of actives) {
    // Identical key to scripts/cleanup-entities.ts:62.
    const key = `${e.type.toLowerCase()} ${e.label.trim().toLowerCase()}`;
    (exactGroups.get(key) ?? exactGroups.set(key, []).get(key)!).push(e);
  }
  for (const grp of exactGroups.values()) {
    if (grp.length < 2) continue;
    executeMerge(grp);
  }

  // 2. LLM dedup pass over the survivors. Reload actives AFTER the pre-merge (some ids are now
  //    superseded). Group by normalized type and send each type-group to the LLM in its own
  //    try/catch (EC-3: a failed batch logs, increments batches_failed, and the pass continues).
  const survivors = loadGraph().filter((e) => e.superseded_by === null);
  const byType = new Map<string, EntityRecord[]>();
  for (const e of survivors) {
    (byType.get(e.type) ?? byType.set(e.type, []).get(e.type)!).push(e);
  }

  for (const group of byType.values()) {
    if (group.length < 2) continue; // a lone entity of a type can't have a same-type duplicate
    let groups: DedupGroup[];
    try {
      const raw = identify(DEDUP_PROMPT + '\n\nENTITIES:\n' + JSON.stringify(group));
      const parsed = (raw ?? {}) as { groups?: DedupGroup[] };
      groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    } catch (err) {
      console.error('[MOT/maintainer] dedup batch failed:', err);
      status.batches_failed += 1;
      status.ok = false;
      status.error = String(err);
      continue; // EC-3 — next type batch still runs
    }

    for (const g of groups) {
      // Gate at confidence ≥ 0.85 (the LLM-identify/deterministic-execute boundary).
      if (typeof g.confidence !== 'number' || g.confidence < 0.85) continue;

      // EC-8 — re-validate member ids against a FRESH loadGraph() (the LLM ran against a snapshot;
      // a concurrent write or an earlier merge this pass may have removed/superseded an id). Drop
      // any id not present-and-active now.
      const freshById = new Map(
        loadGraph()
          .filter((e) => e.superseded_by === null)
          .map((e) => [e.id, e]),
      );
      const validMembers: EntityRecord[] = [];
      for (const id of g.member_ids ?? []) {
        const rec = freshById.get(id);
        if (rec) validMembers.push(rec);
      }

      // B4 hard invariant — a single-member "group" is a no-op. Single-entity retype is DEFERRED;
      // NEVER supersede a lone non-duplicate on an LLM boolean (that would violate FR-17 with no
      // structural grounding). Only genuine ≥2-member merges proceed.
      if (validMembers.length < 2) continue;

      executeMerge(validMembers);
    }
  }

  return status;
}
