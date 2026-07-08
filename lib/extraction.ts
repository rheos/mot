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

import { appendEntity, searchEntities, appendRelate, isRelType, type EntityRecord } from './graph';
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
// labels (not ids); processRelations resolves each to an entity id via matchByLabel. `from_type`/
// `to_type` are syntactically optional so an absent hint degrades gracefully (typed-then-widen
// falls back to a type-agnostic scan), but they are LOAD-BEARING: EXTRACTION_PROMPT_GUIDANCE
// requires the bot to populate them on every draft (infra edges especially — see the infra
// typing table there), and matchByLabel uses them to scope the candidate pool.
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

// matchByLabel — the label→entity resolver for edge ENDPOINTS (A2). Distinct from
// processEntities' Levenshtein dedup scan (untouched): a fuzzy false-positive here mis-wires a
// structural fact into the confirmed BFS — a worse failure than a dropped candidate — so the
// Levenshtein-≤2 arm is DELIBERATELY ABSENT (W2). A 'mot'/'moi' decoy (distance 1, no exact
// match) must NOT resolve.
//
// Two-stage match WITHIN a pool (W2 — exact-match-preferred):
//   1. exact (case-insensitive, whitespace-trimmed) matches first;
//   2. only on ZERO exact matches, fall back to prefix/suffix containment (shorter label ≥4
//      chars, one label a prefix/suffix of the other).
// The caller decides on count: 1 → resolved, >1 → ambiguous, 0 → unresolved.
function matchInPool(needle: string, pool: EntityRecord[]): EntityRecord[] {
  const target = needle.trim().toLowerCase();

  const exact = pool.filter((e) => e.label.trim().toLowerCase() === target);
  if (exact.length >= 1) return exact;

  // Zero exact matches → prefix/suffix containment (both labels ≥4 chars via the shorter one).
  return pool.filter((e) => {
    const label = e.label.trim().toLowerCase();
    const shorter = Math.min(target.length, label.length);
    if (shorter < 4) return false;
    return (
      target.startsWith(label) ||
      target.endsWith(label) ||
      label.startsWith(target) ||
      label.endsWith(target)
    );
  });
}

// matchByLabel — W1 typed-then-widen. When `type` is present, match within the same-type pool
// first (searchEntities('', type) — the proven type-filtered active scan). "Candidates" means
// LABEL-matches in that pool, not merely nodes of that type. Zero label-matches from the typed
// scan → WIDEN to a type-agnostic scan (searchEntities('')) and match there — a mistyped/mismatched
// hint never silently hard-drops a real edge (AC-19). When `type` is absent, the scan is
// type-agnostic from the start.
function matchByLabel(label: string, type?: EntityRecord['type']): EntityRecord[] {
  if (type !== undefined) {
    const typed = matchInPool(label, searchEntities('', type));
    if (typed.length >= 1) return typed;
    // Widen: zero same-type label-matches.
    return matchInPool(label, searchEntities(''));
  }
  return matchInPool(label, searchEntities(''));
}

// processRelations — fan the relation_draft JSON text out into unconfirmed candidate `relate`
// patches (FR9). Mirrors processEntities/processProcedural: never throws; a malformed draft warns
// and returns so the entity/procedural passes for the same row are unaffected (EC5). Each candidate
// is gated at passesConfidence (≥0.85), validated against the closed rel vocabulary, then has both
// endpoints resolved via matchByLabel. Zero-match / >1-match (ambiguous) / self-relate / invalid-rel
// are each skipped and logged. A clean pair appends confirmed:false, source:'session:<id>'.
function processRelations(digestRow: DigestRow): void {
  if (digestRow.relation_draft === null) return;

  let items: BotRelationDraftItem[];
  try {
    items = JSON.parse(digestRow.relation_draft) as BotRelationDraftItem[];
  } catch {
    console.warn(
      `[MOT/extraction] session ${digestRow.session_id}: relation_draft parse error — skipping`,
    );
    return;
  }

  for (const item of items) {
    if (!passesConfidence(item.confidence)) {
      console.warn(
        `[MOT/extraction] relation below threshold (conf=${item.confidence}): ${item.from_label} ${item.rel} ${item.to_label}`,
      );
      continue;
    }

    if (!isRelType(item.rel)) {
      console.warn(
        `[MOT/extraction] relation skipped — invalid rel "${item.rel}": ${item.from_label} → ${item.to_label}`,
      );
      continue;
    }

    const fromMatches = matchByLabel(item.from_label, item.from_type);
    if (fromMatches.length === 0) {
      console.warn(`[MOT/extraction] relation skipped — from_label unresolved: "${item.from_label}"`);
      continue;
    }
    if (fromMatches.length > 1) {
      console.warn(
        `[MOT/extraction] relation skipped — from_label "${item.from_label}" ambiguous (${fromMatches.length} candidates)`,
      );
      continue;
    }

    const toMatches = matchByLabel(item.to_label, item.to_type);
    if (toMatches.length === 0) {
      console.warn(`[MOT/extraction] relation skipped — to_label unresolved: "${item.to_label}"`);
      continue;
    }
    if (toMatches.length > 1) {
      console.warn(
        `[MOT/extraction] relation skipped — to_label "${item.to_label}" ambiguous (${toMatches.length} candidates)`,
      );
      continue;
    }

    const fromId = fromMatches[0].id;
    const toId = toMatches[0].id;

    if (fromId === toId) {
      console.warn(
        `[MOT/extraction] relation skipped — self-relate after resolution: "${item.from_label}" ${item.rel} "${item.to_label}"`,
      );
      continue;
    }

    // Candidate edge — always confirmed:false (confirmation is a separate step, FR9/A5).
    appendRelate(fromId, item.rel, toId, item.confidence, `session:${digestRow.session_id}`, false);
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
