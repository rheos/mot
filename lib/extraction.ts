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

import { appendEntity, searchEntities } from './graph';
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

export interface BotDigestPayload {
  entity_draft: BotEntityDraftItem[] | null;
  procedural_raw: BotProceduralRawItem[] | null;
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

Output format: JSON object with two arrays:
  entity_draft: [ { type, label, properties, confidence, reason } ]
  procedural_raw: [ { category, note, confidence, reason } ]
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

/**
 * The extraction pass. Fans a persisted digest row out into the entity graph and the procedural
 * notes table. Pure deterministic TypeScript — no LLM call, no subprocess.
 *
 * Guard (return early, no-op) when:
 *   - parse_error is truthy — the bot's run_digest failed to produce structured JSON (EC-4, A-1).
 *   - both entity_draft and procedural_raw are null — the structural digest path (FR 16, A-1).
 *
 * async so the digest route can fire-and-forget it (.catch) without blocking the response; the
 * body itself is synchronous (better-sqlite3 + appendFileSync are sync).
 */
export async function runExtraction(digestRow: DigestRow): Promise<void> {
  if (digestRow.parse_error !== 0) return; // EC-4, A-1 — parse_error is the 0/1 raw integer.
  if (digestRow.entity_draft === null && digestRow.procedural_raw === null) return; // FR 16, A-1.

  processEntities(digestRow);
  processProcedural(digestRow);
}
