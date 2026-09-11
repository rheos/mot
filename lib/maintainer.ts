// Recallatron Maintainer. The nightly memory-upkeep workers organize and connect memory but
// never forget it. Every mutation is
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

import fs from 'node:fs';
import path from 'node:path';
import { linkRelationDraft, type LinkResult } from '../scripts/backfill-relations';
import {
  appendEntityRecord,
  appendResolvedRelate,
  appendSupersede,
  confirmEntity,
  loadGraph,
  resolveEdge,
  type EntityRecord,
  type RelatePatch,
} from './graph';
import type { BotRelationDraftItem } from './extraction';
import type { ProfileStatus } from './profile';
import { identifyViaProvider } from './llm-provider';

// ── The shared LLM helper ──────────────────────────────────────────────────────
// Delegates to the provider seam (lib/llm-provider.ts — novadiem-engineering standard 14): the
// caller owns the prompt, this runs it via whichever backend MAINTAINER_LLM_PROVIDER selects
// (headless `claude -p` by default, OpenRouter as the swap-in) and returns the first balanced JSON
// object, or null when the output has no `{`. A non-zero exit throws (the caller's per-batch
// try/catch turns that into batches_failed — EC-3). Kept as `identifyViaClaude` — the name every
// call site (this file, lib/profile.ts, scripts/backfill-relations.ts) already imports as the
// default `identify`/`synthesize` param — so swapping providers is zero call-site changes.
export function identifyViaClaude(prompt: string): unknown {
  return identifyViaProvider(prompt);
}

// ── Batch size (scale fix) ──────────────────────────────────────────────────────
// How many entities go into a SINGLE `claude -p` prompt. The v1 workers sent the ENTIRE active
// set (~182 entities, full properties) in one prompt; on the 1.9GB-RAM prod box (~788MB free) that
// one invocation is OOM-killed in ~3s (SIGTERM/exit 143). A small prompt runs fine, so the workers
// now BATCH: send ≤ MAINTAINER_BATCH_SIZE entities per call, sequentially (never concurrent — two
// live `claude -p` processes would multiply the memory the box can't spare), and aggregate.
// Env-configurable so the batch size can be tuned on the box without a redeploy; guarded against
// 0/NaN/negative (any of which would make chunk() loop forever or send an empty prompt).
const MAINTAINER_BATCH_SIZE =
  Number.isFinite(Number(process.env.MAINTAINER_BATCH_SIZE)) &&
  Number(process.env.MAINTAINER_BATCH_SIZE) > 0
    ? Math.floor(Number(process.env.MAINTAINER_BATCH_SIZE))
    : 25;

// Split an array into consecutive chunks of at most `size`. Pure; size is always ≥1 here (the
// constant above guarantees it), so no zero-size infinite-loop risk.
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Status file (Phase 4) ──────────────────────────────────────────────────────
// The observable last-run summary for maintainer workers. Written after every worker run (nightly
// cron OR on-demand maintainer_run), read by the maintainer_status MCP tool. The file lives
// beside graph.jsonl and is REGENERABLE (a stale/absent/corrupt file degrades to zero-state,
// never throws — W4/AC-8) so it is NOT backup-worthy, unlike graph.jsonl.

export interface MaintainerStatus {
  resolution: ResolutionStatus | ZeroResolution;
  dedup: DedupStatus | ZeroDedup;
  autoconfirm: AutoconfirmStatus | ZeroAutoconfirm;
  profile: ProfileStatus | ZeroProfile;
}

// The zero-state sub-objects have `last_run: null` (no pass has run yet); the live worker
// statuses have `last_run: string`. A union keeps both assignable without a cast.
type ZeroResolution = Omit<ResolutionStatus, 'last_run'> & { last_run: null };
type ZeroDedup = Omit<DedupStatus, 'last_run'> & { last_run: null };
type ZeroAutoconfirm = Omit<AutoconfirmStatus, 'last_run'> & { last_run: null };
type ZeroProfile = Omit<ProfileStatus, 'last_run'> & { last_run: null };

// The all-nulls/zeros/false object returned when no pass has run yet (or the file is
// unparseable). No entities_retyped field (B4 — single-entity retype deferred).
function zeroStatus(): MaintainerStatus {
  return {
    resolution: {
      last_run: null,
      ok: false,
      named_nodes_minted: 0,
      edges_linked: 0,
      batches_failed: 0,
      error: null,
    },
    dedup: {
      last_run: null,
      ok: false,
      entities_merged: 0,
      backup_path: null,
      batches_failed: 0,
      error: null,
    },
    autoconfirm: {
      last_run: null,
      ok: false,
      candidates_scanned: 0,
      entities_confirmed: 0,
      error: null,
    },
    profile: {
      last_run: null,
      ok: false,
      input_entities: 0,
      items_written: 0,
      output_path: null,
      batches_failed: 0,
      error: null,
      preview_markdown: null,
    },
  };
}

// The status file path — derived from the SAME directory as the graph file (MOT_GRAPH_PATH's
// dir in tests/temp; ontology/ in production). Never inside graph.jsonl itself.
function statusFilePath(): string {
  const graphPath = process.env.MOT_GRAPH_PATH;
  const dir = graphPath ? path.dirname(graphPath) : path.join(process.cwd(), 'ontology');
  return path.join(dir, 'maintainer-status.json');
}

/**
 * Crash-atomic status write (W4): write to `<path>.tmp` then rename over the real path — the
 * same temp-then-rename pattern as scripts/cleanup-entities.ts:139, so a crash mid-write can
 * never leave a truncated status file. Creates the directory if absent.
 */
export function writeStatus(status: MaintainerStatus): void {
  const file = statusFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Read the persisted status, or the zero-state object when the file is ABSENT or UNPARSEABLE
 * (W4/AC-8: a truncated/corrupt file degrades to zero-state, never throws — consistent with
 * the never-throw MCP convention). Missing sub-objects are back-filled from zero-state so a
 * partially-written file (only one worker has ever run) still returns a complete shape.
 */
export function readStatus(): MaintainerStatus {
  const file = statusFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return zeroStatus(); // absent
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MaintainerStatus>;
    const zero = zeroStatus();
    return {
      resolution: parsed.resolution ?? zero.resolution,
      dedup: parsed.dedup ?? zero.dedup,
      autoconfirm: parsed.autoconfirm ?? zero.autoconfirm,
      profile: parsed.profile ?? zero.profile,
    };
  } catch {
    return zeroStatus(); // unparseable
  }
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
  service / code repo the user builds, runs, or owns → "Project"; hosts / boxes / domains / accounts and
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
 * Batched send: the active-entity list is split into chunks of MAINTAINER_BATCH_SIZE and each chunk
 * is one sequential `identify` call (never concurrent — a second live `claude -p` would multiply the
 * memory the prod box can't spare). Identifications aggregate across batches; the existing
 * deterministic mint/link step then runs ONCE over the aggregate. A batch that throws logs, bumps
 * batches_failed, and is skipped — the rest still run (EC-3).
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

  // 3. LLM identify — BATCHED. Split the active list into chunks of MAINTAINER_BATCH_SIZE and call
  //    `identify` once per chunk, SEQUENTIALLY, aggregating the identifications. Each batch is in its
  //    own try/catch: a failed batch logs, bumps batches_failed, and is skipped — the others still
  //    run (EC-3). Cross-batch caveat: a canonical subject split across two batches may be minted once
  //    PER batch — two SAME-LABEL nodes for one real thing. The dedup worker's exact-(type,label)
  //    pre-merge collapses that identical-label pair, and the nightly cron runs resolution → dedup in
  //    the same nightly pass, so a double-mint is closed the same night. Lossless + transient (MVP).
  const identifications: IdentificationItem[] = [];
  for (const batch of chunk(actives, MAINTAINER_BATCH_SIZE)) {
    try {
      const raw = identify(RESOLUTION_PROMPT + '\n\nENTITIES:\n' + JSON.stringify(batch));
      const parsed = (raw ?? {}) as { identifications?: IdentificationItem[] };
      if (Array.isArray(parsed.identifications)) identifications.push(...parsed.identifications);
    } catch (err) {
      console.error('[MOT/maintainer] resolution batch failed:', err);
      status.batches_failed += 1;
      status.ok = false;
      status.error = String(err);
      // EC-3 — do NOT return; the remaining batches (and the deterministic mint step below over
      // whatever DID identify) still run.
    }
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

  persistResolutionStatus(status, dryRun);
  return status;
}

// Persist only the `resolution` sub-object of the status file, folding it over whatever the
// dedup worker last wrote (read-modify-write so the two workers never clobber each other's
// sub-object). Skipped in dry-run — a dry-run writes NOTHING (AC-9). Never throws (a status
// write failure must not fail the worker); logs and moves on.
function persistResolutionStatus(status: ResolutionStatus, dryRun: boolean): void {
  if (dryRun) return;
  try {
    const current = readStatus();
    current.resolution = status;
    writeStatus(current);
  } catch (e) {
    console.error('[MOT/maintainer] failed to write resolution status:', e);
  }
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

// True for a plain object (not null, not an array) — the only shape we recurse into when deep-merging
// a conflicting key. Scalars, arrays, and null keep canonical-wins (no merge).
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * W1 / FR-10 — deep-merge a loser's props UNDER a canonical's props, canonical-wins on every LEAF
 * conflict, but recursing into a key that is a plain object on BOTH sides so no nested value is lost.
 *
 * The shallow `{ ...loser, ...canonical }` spread drops the loser's nested content whenever a
 * top-level object key exists on both sides (canonical's whole object wins, loser's disjoint subkeys
 * vanish). FR-10 ("no value lost") forbids that: for an object-valued key present on both, recurse so
 * both objects' subkeys survive (canonical still wins where they truly collide). Scalars/arrays/null
 * keep canonical-wins (an array is not deep-merged — element identity is ambiguous).
 */
function deepMergePreferCanonical(
  loser: Record<string, unknown>,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...loser };
  for (const [k, cv] of Object.entries(canonical)) {
    const lv = out[k];
    out[k] =
      isPlainObject(lv) && isPlainObject(cv) ? deepMergePreferCanonical(lv, cv) : cv;
  }
  return out;
}

/**
 * Select the canonical survivor of a duplicate group and additively union every merged-away
 * entity's properties into it (FR-8/FR-10). Lifted from scripts/cleanup-entities.ts:71-98 so the
 * script and the dedup worker share ONE merge core.
 *
 * Selection order (the cleanup-entities order): highest `confidence`, then most properties
 * (excluding `relations`), then earliest `valid_from`.
 *
 * Property union is ADDITIVE and canonical-wins via deepMergePreferCanonical — the survivor's value
 * wins on a LEAF key conflict, but EVERY key from EVERY merged-away entity that the survivor lacks is
 * imported, AND a key that is a plain object on BOTH sides is DEEP-merged so the loser's disjoint
 * nested subkeys are not silently dropped (W1/FR-10 — no value lost, nested content included). A
 * plain `{ ...dupProps, ...survivor }` spread would drop the loser's nested content under any shared
 * object key; FR-10 is a hard invariant, not best-effort. `relations` is excluded from the union
 * (edges are re-folded from patches at read time).
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
    const { relations: survRels, ...survProps } = survivor.properties ?? {};
    // canonical (survivor) wins on leaf conflict; every other key is imported and object-valued
    // conflicts deep-merge so no nested value is lost (FR-10 hard). Re-attach the folded relations
    // untouched (edges are never a merge property).
    survivor.properties = { ...deepMergePreferCanonical(dupProps, survProps), relations: survRels };
    if (survRels === undefined) delete survivor.properties.relations;
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
 * The APPEND path for the dedup worker's edge re-point (EC-5/B1/B2). Takes the COMPLETE pass-wide
 * `mergedAwayId → survivorId` map (every duplicate collapsed anywhere in the pass, across ALL groups)
 * and re-points once over every affected triple. Collect every distinct (from, rel, to) triple in
 * `graphFile` where `from` OR `to` is ANY merged-away id in the map, fold each via resolveEdge (which
 * folds all three patch kinds — relate + confirm_relate + unrelate), pass the folded patches through
 * the shared computeRepointedEdges (which re-points BOTH endpoints against the same complete map +
 * drops self-loops), and appendResolvedRelate each survivor edge — one JSONL line per surviving
 * triple, carrying the folded valid_until/confirmed verbatim.
 *
 * Passing the WHOLE map (not one entry per merge) is the EC-12 correctness fix: an edge whose two
 * endpoints are losers of TWO DIFFERENT groups (a1→b1, where a1→A and b1→B this pass) folds to
 * A→B — both ends resolved in one shot. A per-group single-entry map re-pointed only a1, leaving
 * A→b1 pointing at the now-dead b1 (a phantom neighbour that survives across passes). Re-pointing
 * both endpoints against the complete map makes the append path converge with the cleanup-entities
 * atomic-rewrite path, which already uses one whole-pass map.
 *
 * A triple with no base `relate` folds to null (resolveEdge returns null) and is skipped: an orphan
 * confirm_relate/unrelate never established an edge, so there is nothing to re-point.
 *
 * `graphFile` MUST equal the value loadGraph() resolves (MOT_GRAPH_PATH or the ontology/ default);
 * the worker passes resolveGraphFile(), tests pass their temp path.
 */
export function repointEdges(mergedAwayMap: Map<string, string>, graphFile: string): void {
  if (mergedAwayMap.size === 0) return;
  if (!fs.existsSync(graphFile)) return;

  // Collect every DISTINCT (from, rel, to) triple that touches ANY merged-away id in the map, across
  // all three patch kinds (a human unrelate/confirm_relate is keyed on the SAME natural key as its
  // relate). A triple between two DIFFERENT groups' losers is collected here (either endpoint hits)
  // and re-pointed at BOTH ends by computeRepointedEdges.
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
      (mergedAwayMap.has(r.from) || mergedAwayMap.has(r.to))
    ) {
      triples.add(`${r.from}|${r.rel}|${r.to}`);
    }
  }

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
 * (no LLM, handles EC-6 concurrent-mint duplicates) → LLM dedup pass over the survivors (grouped by
 * type, then each type-group CHUNKED to ≤ MAINTAINER_BATCH_SIZE entities per `claude -p` call so the
 * prompt fits the prod box RAM — sequential calls, each in its own try/catch — EC-3). Each group is
 * DECIDED (mergeGroup → appendSupersede,
 * skipping already-superseded — FR-19 idempotency → persist the survivor's unioned properties),
 * accumulating every dup→survivor into ONE pass-wide `mergedAwayMap`. The edge re-point fires ONCE at
 * the end over that COMPLETE map (EC-12) — NOT once per group with a single-entry map, which left an
 * edge between two groups' losers pointing at a dead node. dryRun logs and writes nothing.
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

  // The ONE pass-wide merged-away map (every dup→survivor decided anywhere in this pass, across the
  // pre-pass AND every LLM type-batch). The edge re-point reads THIS complete map once at the end so
  // an edge whose two endpoints are losers of two DIFFERENT groups folds to survivorA→survivorB (both
  // ends resolved). Populated per group by executeMerge; consumed once after both passes (EC-12).
  const mergedAwayMap = new Map<string, string>();

  // Decide + persist one already-selected member group: mergeGroup (survivor-select + additive
  // property union — FR-10) → per merged-away id { supersede (skip if already superseded — FR-19),
  // record dup→survivor in the pass-wide map } → persist the survivor's unioned properties
  // (append-only re-write, same id). Edge re-point is DEFERRED to a single whole-pass call. In
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
      mergedAwayMap.set(dup.id, survivor.id); // EC-12 — accumulate; re-point once at the end
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
  //    superseded). Group by type (duplicates are same-type), then CHUNK each type-group to
  //    ≤ MAINTAINER_BATCH_SIZE entities per `claude -p` call so the prompt fits the prod box RAM —
  //    a type-group ≤ batch size is one call; a larger one is split into sub-batches. Calls are
  //    SEQUENTIAL, each in its own try/catch (EC-3: a failed batch logs, bumps batches_failed, and
  //    the pass continues). Cross-batch caveat: a FUZZY (non-exact-label) duplicate pair split across
  //    two sub-batches of a single same-type group larger than MAINTAINER_BATCH_SIZE is never seen
  //    together by one `claude -p` call, so it is missed — and because loadGraph() returns STABLE
  //    insertion order, the chunk boundaries are identical every run, so it stays missed (not just
  //    "next pass"). This is bounded + SAFE: exact-label dups are caught by the deterministic pre-merge
  //    above regardless of chunking; the only un-caught case is a fuzzy dup inside one oversized
  //    type-group, and its failure mode is OVER-RETENTION (two similar entities kept — never a wrong
  //    merge, never a lost fact), which is consistent with the memory-is-forever invariant. Accepted
  //    for MVP (no type-group is near the default 25 at current scale). Future: randomize group order
  //    before chunking so successive nights eventually pair a straddling fuzzy dup.
  const survivors = loadGraph().filter((e) => e.superseded_by === null);
  const byType = new Map<string, EntityRecord[]>();
  for (const e of survivors) {
    (byType.get(e.type) ?? byType.set(e.type, []).get(e.type)!).push(e);
  }

  // Flatten to the actual per-call batches: one type-group when it fits, else its sub-chunks. A
  // batch with <2 entities can't hold a same-type duplicate, so it's dropped before the LLM call.
  const batches: EntityRecord[][] = [];
  for (const group of byType.values()) {
    for (const sub of chunk(group, MAINTAINER_BATCH_SIZE)) {
      if (sub.length >= 2) batches.push(sub);
    }
  }

  for (const batch of batches) {
    let groups: DedupGroup[];
    try {
      const raw = identify(DEDUP_PROMPT + '\n\nENTITIES:\n' + JSON.stringify(batch));
      const parsed = (raw ?? {}) as { groups?: DedupGroup[] };
      groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    } catch (err) {
      console.error('[MOT/maintainer] dedup batch failed:', err);
      status.batches_failed += 1;
      status.ok = false;
      status.error = String(err);
      continue; // EC-3 — next batch still runs
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

  // 3. EC-12 — ONE edge re-point over the COMPLETE pass-wide map, AFTER every group is decided and
  //    superseded. This is the correctness fix: a live edge between the losers of two different
  //    groups (a1→b1, where a1→A and b1→B this pass) is re-pointed at BOTH ends to A→B in one shot,
  //    instead of leaving A→b1 pointing at the now-dead b1 (a phantom neighbour). Flatten the map to
  //    FINAL survivors first so a chained merge (a1→A, then A→X folds A as a loser) resolves a1→X too.
  if (!dryRun && mergedAwayMap.size > 0) {
    repointEdges(flattenToFinalSurvivors(mergedAwayMap), graphFile);
  }

  persistDedupStatus(status, dryRun);
  return status;
}

// Persist only the `dedup` sub-object of the status file, folding it over whatever the
// resolution worker last wrote (read-modify-write). Skipped in dry-run (AC-9). Never throws.
function persistDedupStatus(status: DedupStatus, dryRun: boolean): void {
  if (dryRun) return;
  try {
    const current = readStatus();
    current.dedup = status;
    writeStatus(current);
  } catch (e) {
    console.error('[MOT/maintainer] failed to write dedup status:', e);
  }
}

// ── Worker 3: auto-confirm ─────────────────────────────────────────────────────
// Promotes stable, high-confidence candidate entities to confirmed:true on the nightly pass, so
// downstream consumers gated on `confirmed` (the profile layer especially) populate WITHOUT the user
// doing a manual confirm chore. This is the AUTOMATED arm of confirmation: the machine does the
// chore, so the system stays "ambient, not administered" (no user work required) while still
// building a confirmed set. PURE CODE — no `claude -p`: the gate is deterministic, and the
// RAM-constrained prod box already OOMs the LLM workers.
//
// A promoted confirm is a human-grade affirmation of `confirmed`, so keep the bar deliberately
// stricter than extraction's 0.85: only promote what has PROVEN stable (aged, uncorrected). A wrong
// auto-confirm is fixed by correction/supersede, never deletion — the persistence + correction
// invariants (do-not-regress) still hold; confirmEntity() only appends an op:'confirm' patch.

export interface AutoconfirmStatus {
  last_run: string;
  ok: boolean;
  candidates_scanned: number; // entities that cleared the gate
  entities_confirmed: number; // confirms actually appended (== scanned unless a write failed)
  error: string | null;
}

// Env knob reader (read at CALL time so the bar is tunable on the box without a redeploy, and each
// test can set it per-case). Guarded against NaN/negative → falls back. Floats allowed (confidence).
function autoconfirmNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * The auto-confirm worker. Scans the folded graph and confirms every UNCONFIRMED, LIVE entity that
 * clears the promotion gate (all env-tunable, read here at call time):
 *   - confidence ≥ MAINTAINER_AUTOCONFIRM_MIN_CONFIDENCE (default 0.9 — above extraction's 0.85)
 *   - aged ≥ MAINTAINER_AUTOCONFIRM_MIN_AGE_DAYS since valid_from (default 7) — survived without
 *     correction; a just-extracted fact is NOT promoted, leaving room for same-week correction
 *   - superseded_by === null AND valid_until === null (live)
 *   - NOT flagged properties.probable_duplicate_of (let the dedup worker resolve it first)
 * dryRun scans + counts (entities_confirmed = would-confirm count) but appends nothing and writes
 * no status. `now` is injectable for deterministic age-gate tests (defaults to wall-clock).
 */
export function autoconfirmWorker({
  dryRun,
  now = new Date(),
}: {
  dryRun: boolean;
  now?: Date;
}): AutoconfirmStatus {
  const status: AutoconfirmStatus = {
    last_run: now.toISOString(),
    ok: true,
    candidates_scanned: 0,
    entities_confirmed: 0,
    error: null,
  };

  try {
    const minConfidence = autoconfirmNum('MAINTAINER_AUTOCONFIRM_MIN_CONFIDENCE', 0.9);
    const minAgeMs = autoconfirmNum('MAINTAINER_AUTOCONFIRM_MIN_AGE_DAYS', 7) * 86_400_000;
    const nowMs = now.getTime();

    const eligible = loadGraph().filter((e) => {
      if (e.confirmed === true) return false;
      if (e.superseded_by !== null || e.valid_until !== null) return false;
      if (e.confidence < minConfidence) return false;
      if (Array.isArray(e.properties?.probable_duplicate_of)) return false;
      const validFromMs = Date.parse(e.valid_from);
      if (!Number.isFinite(validFromMs)) return false;
      return nowMs - validFromMs >= minAgeMs;
    });

    status.candidates_scanned = eligible.length;

    if (dryRun) {
      status.entities_confirmed = eligible.length; // would-confirm count
    } else {
      for (const e of eligible) {
        const res = confirmEntity(e.id);
        // confirmEntity is idempotent + typed-result; count only successful confirms.
        if (!('error' in res)) status.entities_confirmed++;
      }
    }
  } catch (e) {
    status.ok = false;
    status.error = String(e);
  }

  persistAutoconfirmStatus(status, dryRun);
  return status;
}

// Persist only the `autoconfirm` sub-object, folding it over what the earlier workers wrote
// (read-modify-write). Skipped in dry-run. Never throws.
function persistAutoconfirmStatus(status: AutoconfirmStatus, dryRun: boolean): void {
  if (dryRun) return;
  try {
    const current = readStatus();
    current.autoconfirm = status;
    writeStatus(current);
  } catch (e) {
    console.error('[MOT/maintainer] failed to write autoconfirm status:', e);
  }
}

/**
 * Flatten a dup→survivor map to dup→FINAL-survivor by following each chain to a fixed point (EC-12).
 * A single pass can produce a chain — e.g. the pre-pass merges a2→A, then the LLM groups {A, X} and
 * selects X, adding A→X. An edge off a2 must land on X, not the now-superseded A. Cycle-guarded
 * (a corrupt self-referential chain terminates instead of looping).
 */
function flattenToFinalSurvivors(map: Map<string, string>): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [dup, surv] of map) {
    let final = surv;
    const seen = new Set<string>([dup]);
    while (map.has(final) && !seen.has(final)) {
      seen.add(final);
      final = map.get(final)!;
    }
    flat.set(dup, final);
  }
  return flat;
}
