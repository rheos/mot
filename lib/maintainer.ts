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
import { linkRelationDraft, type LinkResult } from '../scripts/backfill-relations';
import { loadGraph, type EntityRecord } from './graph';
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
