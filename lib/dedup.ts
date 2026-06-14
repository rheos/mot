import type BetterSqlite3 from 'better-sqlite3';
import type { Severity } from './enums';

// ── Dedup layer (FR-API-1, OQ-P7, AC-EC1/EC3/EC4) ─────────────────────────────
// THE FROZEN PHASE-1 CONTRACT. The decision table here IS the product. Do not add
// body-diff logic (that is the Phase 2 `updated` trigger). Evaluate top-to-bottom on a
// `dedup_key` match; first matching row wins:
//
//   was done?                          → reopened (200)   — re-open wins over severity
//   else incoming severity STRICTLY higher → updated  (200)   — and raise stored severity
//   else                               → grouped  (200)   — same-severity repeat ALWAYS groups
//   no dedup_key match / source_ref null   → created  (201)
//
// `ministry` is NEVER in the lookup and is NEVER reset by a dedup update (AC-EC3).

// The action a POST resolved to. Mirrors classification_audit.action's create-path values.
export type DedupAction = 'created' | 'updated' | 'reopened' | 'grouped';

// What resolveDedup decides. `existingId` is null only for `created`.
export interface DedupResult {
  action: DedupAction;
  existingId: string | null;
  // The severity to store. For `updated` this is the (higher) incoming value; otherwise the
  // existing/incoming value carried through. Lets the caller apply the one allowed field bump.
  severityToStore: Severity;
}

// What resolveDedup needs from the validated POST payload to make its decision.
export interface DedupInput {
  source_ref: string | null;
  ticket_type: string;
  severity: Severity;
}

// Severity rank for the strictly-higher comparison: critical > high > normal > low.
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
};

// ── computeDedupKey ───────────────────────────────────────────────────────────
// `source_ref + ':' + ticket_type`, computed ONCE. The literal contract formula (FR-DB-1,
// OQ-P7). NEVER parsed back: it is opaque, stored in its own indexed column, and looked up
// only by whole-string equality. `ticket_type` is validated colon-free at the API boundary
// (Prompt 5 Zod guard), which keeps this concatenation injective — no two distinct
// (source_ref, ticket_type) pairs can alias to the same key.
export function computeDedupKey(sourceRef: string, ticketType: string): string {
  return `${sourceRef}:${ticketType}`;
}

// Row shape the dedup lookup pulls — only the fields the decision needs.
interface DedupRow {
  id: string;
  status: string;
  severity: Severity;
}

// ── resolveDedup ──────────────────────────────────────────────────────────────
// Runs INSIDE the POST transaction (the same tx that will then insert/update). Looks up the
// dedup_key across status IN (open, watching, done) and returns the action + the row to act
// on. It decides; it does not mutate — createTicket applies the write per the action so the
// whole POST stays one atomic transaction.
export function resolveDedup(
  input: DedupInput,
  tx: BetterSqlite3.Database,
): DedupResult {
  // source_ref null → no identity to match on → always create (EC-ARCH-5). dedup_key stays null.
  if (input.source_ref === null) {
    return { action: 'created', existingId: null, severityToStore: input.severity };
  }

  const dedupKey = computeDedupKey(input.source_ref, input.ticket_type);

  // The one dedup query, on idx_ticket_dedup_key. Whole-string equality; never a back-parse.
  // archived/snoozed are intentionally excluded — only open/watching/done can absorb a repeat.
  const existing = tx
    .prepare(
      `SELECT id, status, severity FROM ticket
         WHERE dedup_key = ? AND status IN ('open', 'watching', 'done')
         LIMIT 1`,
    )
    .get(dedupKey) as DedupRow | undefined;

  // No live match → create.
  if (!existing) {
    return { action: 'created', existingId: null, severityToStore: input.severity };
  }

  // Match on a done ticket → re-open, unconditionally. reopened wins over the severity check.
  if (existing.status === 'done') {
    // Carry the existing severity through — a re-open does NOT raise severity (only `updated`
    // does, and that branch is below/unreachable once we're here).
    return {
      action: 'reopened',
      existingId: existing.id,
      severityToStore: existing.severity,
    };
  }

  // Match on open|watching. The ONLY Phase-1 `updated` trigger: incoming severity strictly
  // higher than the stored value. Then raise the stored severity to the incoming value.
  if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]) {
    return {
      action: 'updated',
      existingId: existing.id,
      severityToStore: input.severity,
    };
  }

  // Every other open|watching match → grouped. Same-or-lower severity, body/title ignored in
  // Phase 1. severity is NOT lowered — keep the existing (higher-or-equal) stored value.
  return {
    action: 'grouped',
    existingId: existing.id,
    severityToStore: existing.severity,
  };
}
