// Recallatron Phase 4 — the post-digest extraction pass (FR 16–19, EC-4/5/6, A-1/A-6, AC-4/7/8).
//
// Pure deterministic TypeScript. Runs in-process AFTER upsertDigest() persists a digest row;
// it does NOT call any LLM (the bot already did that in run_digest, producing entity_draft and
// procedural_raw as JSON text). This pass parses those fields and fans them out:
//   - entity_draft → appendEntity() in lib/graph.ts, gated at confidence >= 0.85 (EC-5),
//     always confirmed:false (AC-7).
//   - procedural_raw → insertCandidate() in lib/procedural.ts, always confirmed=0 (AC-8),
//     dedup handled by insertCandidate (OQ-5).
// Architecture §OQ-2: this is the digest trigger point — the extraction fires from the digest
// route handler, in TypeScript, not in the (separate) Python bot codebase.

import { appendEntity, searchEntities, loadGraph, type EntityRecord } from './graph';
import { linkRelationDraft } from '../scripts/backfill-relations';
import { insertCandidate } from './procedural';
import { levenshtein } from './levenshtein';
import { nowIso } from './time';
import type { DigestRow } from './digest';

// BLOCKER 2 — the in-repo statement of the bot-produced JSON contract. These are the shapes
// INSIDE digestRow.entity_draft / digestRow.procedural_raw (which are JSON text on the row).
// Named Bot* to avoid colliding with lib/digest.ts's own DigestPayload (the route's wire shape).
export interface BotEntityDraftItem {
  type: 'Person' | 'Project' | 'Deadline' | 'Preference' | 'Fact';
  label: string;
  properties: {
    [k: string]: unknown;
  };
  confidence: number; // 0.0–1.0; compared at >= 0.85 threshold (EC-5)
  reason?: string;
}

export interface BotProceduralRawItem {
  category?: string;
  note: string;
  confidence?: number;
  reason?: string;
}

// Track 6 — the bot-produced candidate-edge shape. `from_label`/`to_label` are HUMAN-READABLE
// labels (not ids); processRelations resolves each to an entity id via linkRelationDraft's
// resolve-or-create (exact-label match, or MINT a node of the endpoint's type). `from_type`/
// `to_type` are syntactically optional so an absent hint degrades gracefully (falls back to a
// verb-derived type hint, then 'Fact'), but they are LOAD-BEARING: EXTRACTION_PROMPT_GUIDANCE
// requires the bot to populate them on every draft (infra edges especially — see the infra
// typing table there), because they type the node that gets minted for a not-yet-existing endpoint.
export interface BotRelationDraftItem {
  from_label: string;
  rel: string;
  to_label: string;
  confidence: number;
  reason?: string;
  from_type?: EntityRecord['type'];
  to_type?: EntityRecord['type'];
}

export interface BotDigestPayload {
  entity_draft: BotEntityDraftItem[] | null;
  procedural_raw: BotProceduralRawItem[] | null;
  relation_draft: BotRelationDraftItem[] | null;
}

// Synthetic ground truth for the unit tests. Exercises the EC-5 boundary (0.85 passes,
// 0.8499 fails) and the procedural dedup path (two notes with the same text).
export const TEST_DIGEST_FIXTURE: BotDigestPayload = {
  entity_draft: [
    { type: 'Person', label: 'Alex Goodwin', properties: { grade: 'Year 4' }, confidence: 0.9, reason: 'Explicitly stated' },
    { type: 'Project', label: 'SampleApp', properties: { status: 'active' }, confidence: 0.85, reason: 'Stated in session' },
    { type: 'Fact', label: 'Taylor prefers bullet replies maybe', properties: {}, confidence: 0.8499, reason: 'Inferred from tone' },
  ],
  procedural_raw: [
    { category: 'communication', note: 'Taylor prefers bullet replies for ticket lists', confidence: 0.9 },
    { category: 'workflow', note: 'Taylor prefers bullet replies for ticket lists', confidence: 0.8 }, // duplicate
  ],
  relation_draft: null,
};

// The canonical conservative extraction prompt (FR 19 / OQ-3 closure). The bot's run_digest
// uses this guidance verbatim; it lives in-repo so the contract and the prose stay together.
export const EXTRACTION_PROMPT_GUIDANCE = `
You are extracting structured facts from a conversation session transcript.

RULES:
- Emit ONLY things that were EXPLICITLY STATED in the transcript.
- Do NOT infer, speculate, or extrapolate. If Taylor did not say it directly, do not emit it.
- Do NOT emit things implied by Taylor's behavior or tone.
- Confidence must reflect how clearly and directly the fact was stated — not how plausible it seems.

NEGATIVE EXAMPLE (do NOT do this):
  BAD: { "label": "Taylor prefers short replies", "confidence": 0.7, "reason": "Taylor seems to prefer X based on implied behavior" }
  This is inference from tone, not an explicit statement. Do not emit it.

POSITIVE EXAMPLE:
  GOOD: { "label": "Alex is in Year 4", "confidence": 0.95, "reason": "Taylor said 'Alex is in year 4' at turn 3" }
  This is a direct statement with a specific source.

Output format: JSON object with three arrays:
  entity_draft: [ { type, label, properties, confidence, reason } ]
  procedural_raw: [ { category, note, confidence, reason } ]
  relation_draft: [ { from_label, rel, to_label, confidence, reason, from_type, to_type } ]

RELATIONS (relation_draft):
- Emit ONLY relations that were EXPLICITLY STATED. Do NOT infer a relation from co-mention,
  conversational tone, or implied context. If Taylor did not directly state that A is related
  to B, do not emit the edge.
- Confidence reflects how DIRECTLY the relation was stated, not how plausible it seems.
- rel MUST be one of the 10 closed-vocabulary verbs below. Each verb has a FIXED
  subject (from) → object (to) direction — emit from_label/to_label in that order:
    child_of      child → parent                (Alex, child_of, Taylor)
    works_on      agent → project               (Taylor, works_on, SampleApp)
    deadline_for  deadline → the thing it is for (enrollment-form-due, deadline_for, Lincoln Elementary)
    prefers       person → preference           (Taylor, prefers, bullet-replies)
    attends       person → institution          (Alex, attends, Lincoln Elementary)
    belongs_to    asset → account/grouping      (sampleapp.com, belongs_to, growoperative-account)
    owns          agent → asset                 (Taylor, owns, sampleapp.com)
    hosted_on     app/site/service → host/box   (SampleApp, hosted_on, smallhost-sampleapp)
    points_to     domain/subdomain → target     (example.com, points_to, mot)
    depends_on    service → service             (umami, depends_on, supabase-postgres)
- Three-way boundary (these do NOT overlap; owns and belongs_to may coexist on the same node):
    owns       = possession (agent → asset)
    belongs_to = membership  (asset → account/grouping)
    works_on   = labour      (agent → project)
- Populate from_type and to_type on EVERY relation item — infra edges especially. The 5 entity
  types do not grow, so map each infra node class to the right existing type:
    apps / sites / services / code repos (things Taylor builds, runs, works on, or owns as a
      first-class project)                                          → 'Project'
    hosts / boxes / domains / subdomains / accounts / groupings
      (passive infrastructure other things sit on or point at)      → 'Fact'
    people → 'Person'; schedule items → 'Deadline'; stated preferences → 'Preference'
`.trim();

// EC-5 — confidence gate at >= 0.85. Direct float comparison: 0.9 and 0.85 pass, 0.8499 fails.
// NOTE: the prompt suggested rounding to 2dp first (Math.round(c*100)/100 >= 0.85), but that
// rounds 0.8499 UP to 0.85 and would admit it — directly contradicting EC-5's stated outcome
// (the 0.8499 "inferred from tone" item must be rejected). The direct comparison is the behavior
// the spec and the dictated test both require, so it wins over the rounding formula.
function passesConfidence(confidence: number): boolean {
  return confidence >= 0.85;
}

// The 5 canonical entity types. The bot's LLM sometimes emits un-normalised casings
// ('person', 'fact', 'preference'); storing those verbatim fragments the graph — a `person`
// "Alex" and a `Person` "Alex" land in different type buckets, so the type-scoped dedup scan
// never sees them as duplicates AND relation resolution's same-type exact match misses across the casing.
// normalizeEntityType folds any casing back to the canonical type; a value that is not one of the
// five at all returns null (the entity is skipped rather than stored with a garbage type).
const CANONICAL_ENTITY_TYPES = ['Person', 'Project', 'Deadline', 'Preference', 'Fact'] as const;
function normalizeEntityType(raw: unknown): EntityRecord['type'] | null {
  const t = String(raw ?? '').trim().toLowerCase();
  return CANONICAL_ENTITY_TYPES.find((c) => c.toLowerCase() === t) ?? null;
}

// Process the entity_draft JSON text → appendEntity for each item that clears the gate.
// A malformed entity_draft is logged and skipped (EC-4); it never throws, so procedural_raw
// still gets its turn.
function processEntities(digestRow: DigestRow): void {
  if (digestRow.entity_draft === null) return;

  let items: BotEntityDraftItem[];
  try {
    items = JSON.parse(digestRow.entity_draft) as BotEntityDraftItem[];
  } catch {
    console.warn(
      `[MOT/extraction] session ${digestRow.session_id}: entity_draft parse error — skipping`,
    );
    return;
  }

  for (const item of items) {
    if (!passesConfidence(item.confidence)) {
      console.warn(
        `[MOT/extraction] entity below threshold (conf=${item.confidence}): ${item.label}`,
      );
      continue;
    }

    // Normalise the type casing BEFORE the type-scoped dedup scan + append, so 'person' folds to
    // 'Person' (and dedup sees casing-variant duplicates). A type outside the canonical 5 is skipped.
    const normType = normalizeEntityType(item.type);
    if (normType === null) {
      console.warn(
        `[MOT/extraction] entity with unrecognised type "${item.type}" skipped: ${item.label}`,
      );
      continue;
    }
    item.type = normType;

    // Dedup scan: find same-type active entities that are likely duplicates of this label.
    // searchEntities('', type) with an empty q matches all active entities of that type
    // (empty needle → haystack.includes('') is always true; active-only is the default branch
    // at graph.ts:200). This usage is deliberate — OQ-2 confirmed.
    const sameType = searchEntities('', item.type);
    if (sameType.length >= 1000) {
      console.warn(
        `[MOT/extraction] dedup scan large: ${sameType.length} active "${item.type}" entities — proceeding`,
      );
    }
    const dupIds: string[] = [];
    const incomingLower = item.label.toLowerCase();
    for (const existing of sameType) {
      const existingLower = existing.label.toLowerCase();
      const dist = levenshtein(incomingLower, existingLower);
      const shorter = Math.min(incomingLower.length, existingLower.length);
      const prefixOrSuffix =
        shorter >= 4 &&
        (incomingLower.startsWith(existingLower) ||
          incomingLower.endsWith(existingLower) ||
          existingLower.startsWith(incomingLower) ||
          existingLower.endsWith(incomingLower));
      if (dist <= 2 || prefixOrSuffix) {
        dupIds.push(existing.id);
      }
    }
    if (dupIds.length > 0) {
      item.properties = { ...item.properties, probable_duplicate_of: dupIds };
    }
    // confirmed:false is intentional for dedup-flagged items — confirmation is a separate step.

    // AC-7 — extraction-pass entities are NEVER confirmed; confirmation is a separate step.
    appendEntity({
      type: item.type,
      label: item.label,
      properties: item.properties,
      confidence: item.confidence,
      confirmed: false,
      source: `session:${digestRow.session_id}`,
      valid_from: nowIso(),
      valid_until: null,
      superseded_by: null,
    });
  }
}

// Process the procedural_raw JSON text → insertCandidate for each note. insertCandidate already
// inserts unconfirmed (AC-8) and skips note_norm duplicates (OQ-5); a malformed procedural_raw
// is logged and skipped (EC-4) and never throws.
function processProcedural(digestRow: DigestRow): void {
  if (digestRow.procedural_raw === null) return;

  let items: BotProceduralRawItem[];
  try {
    items = JSON.parse(digestRow.procedural_raw) as BotProceduralRawItem[];
  } catch {
    console.warn(
      `[MOT/extraction] session ${digestRow.session_id}: procedural_raw parse error — skipping`,
    );
    return;
  }

  for (const item of items) {
    const result = insertCandidate(
      item.category ?? 'general',
      item.note,
      digestRow.session_id,
      digestRow.chat_id,
    );
    if ('error' in result) {
      console.warn(
        `[MOT/extraction] procedural note skipped (${result.error}): ${item.note}`,
      );
    }
  }
}

// processRelations — fan the relation_draft JSON text out into unconfirmed candidate `relate`
// patches (FR-6). Mirrors processEntities/processProcedural: never throws; a malformed draft warns
// and returns so the entity/procedural passes for the same row are unaffected (EC5).
//
// RESOLVE-OR-CREATE (the FR-6 fix). The old implementation resolved each endpoint via matchByLabel
// and DROPPED the edge when an endpoint matched zero or multiple nodes. Because the graph is
// fact-SENTENCES ("Taylor has a Claude instance…") rather than named nodes, "Taylor" matched many
// sentences by prefix and came back ambiguous — so every live edge was dropped (the 0-edge bug).
// The fix reuses linkRelationDraft from scripts/backfill-relations.ts with create:true: an endpoint
// that doesn't EXACT-match an existing node is MINTED as a canonical named node (confirmed:false,
// source:'session:<id>'), then linked. New conversations grow the graph instead of dropping edges to
// not-yet-existing endpoints. Resolution is exact-label-only (no fuzzy prefix fallback — that fuzzy
// fallback was the original ambiguity that caused the 0-edge bug); linkRelationDraft's resolveOrCreate
// enforces this, so we do NOT reintroduce matchByLabel here.
//
// OQ-5 known gap: if Taylor states a correction in conversation (e.g. "it's Alex not Maya"),
// the live path may mint a "corrected" duplicate node. The nightly dedup worker (Track 9 Phase 3)
// merges it next cycle. No special-casing in v1.
function processRelations(digestRow: DigestRow): void {
  if (digestRow.relation_draft === null) return;

  // Parse-guard identical to processEntities/processProcedural: a malformed draft warns and
  // returns (EC5) so this row's entity/procedural passes are unaffected. linkRelationDraft also
  // guards its own parse, but we mirror the sibling passes' warn-and-return here for a clear log.
  try {
    JSON.parse(digestRow.relation_draft);
  } catch {
    console.warn(
      `[MOT/extraction] session ${digestRow.session_id}: relation_draft parse error — skipping`,
    );
    return;
  }

  // Fresh active-only working set; linkRelationDraft mutates this in place as it mints nodes, so an
  // earlier edge's minted endpoint resolves for a later edge in the same draft.
  const index = loadGraph().filter((e) => e.superseded_by === null);
  // Per-call idempotency only — the live path fires once per digest; cross-run dedup is not needed.
  const seenEdges = new Set<string>();

  const result = linkRelationDraft(digestRow.relation_draft, `session:${digestRow.session_id}`, index, {
    dryRun: false,
    create: true,
    seenEdges,
  });

  for (const s of result.skipped) {
    console.warn(`[MOT/extraction] relation skipped (${s.reason}): ${s.detail}`);
  }
}

/**
 * The extraction pass. Fans a persisted digest row out into the entity graph and the procedural
 * notes table. Pure deterministic TypeScript — no LLM call, no subprocess.
 *
 * Guard (return early, no-op) when:
 *   - parse_error is truthy — the bot's run_digest failed to produce structured JSON (EC-4, A-1).
 *   - entity_draft, procedural_raw, AND relation_draft are all null — the structural digest path
 *     (FR 16, A-1). A relation-only digest (relation_draft non-null, the other two null) still runs.
 *
 * async so the digest route can fire-and-forget it (.catch) without blocking the response; the
 * body itself is synchronous (better-sqlite3 + appendFileSync are sync).
 */
export async function runExtraction(digestRow: DigestRow): Promise<void> {
  if (digestRow.parse_error !== 0) return; // EC-4, A-1 — parse_error is the 0/1 raw integer.
  // FR10 — a relation-only digest (edges between already-known entities, no new entity or
  // procedural draft) must still run, so relation_draft is part of the all-null guard.
  if (
    digestRow.entity_draft === null &&
    digestRow.procedural_raw === null &&
    digestRow.relation_draft === null
  ) {
    return;
  }

  processEntities(digestRow);
  processProcedural(digestRow);
  processRelations(digestRow);
}
