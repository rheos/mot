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
  // True only when the existing row was found via the pre-fix compatibility bridge (a primary
  // dedup_key miss that matched a message-keyed `bridge_source_refs` candidate). Tells
  // createTicket to migrate the matched row to thread identity in the same tx BEFORE the action
  // UPDATE. The matched row is `existingId`; createTicket already holds the thread id
  // (input.source_ref) and ticket_type, so it computes the new dedup_key itself. False on every
  // primary hit and on `created`. (FR-15/17, OQ-5, EC-1, AC-13.)
  bridge: boolean;
}

// What resolveDedup needs from the validated POST payload to make its decision.
export interface DedupInput {
  source_ref: string | null;
  ticket_type: string;
  severity: Severity;
  // The incoming event's classifier fingerprint (classification_audit.signal_fingerprint),
  // or null for provenances that carry no audit block (manual, sentry-alert, stripe-webhook,
  // status-poll, …). Drives the EXISTS reopen gate on a `done` match — see resolveDedup.
  signal_fingerprint: string | null;
  // The message ids observed in this Gmail thread, for the one-time pre-fix compatibility
  // bridge. Empty for heartbeat/manual/post-migration creates. Consulted ONLY on a primary
  // dedup_key miss; each becomes a candidate `msgId:ticket_type` key — see resolveDedup.
  bridge_source_refs: string[];
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

// EXISTS membership read over classification_audit: has this exact (ticket, fingerprint) pair
// been recorded before? Drives the `done` reopen gate. Synchronous, in-transaction (better-
// sqlite3's single-connection model means the outer db handle reads the open tx's writes).
function fingerprintSeen(
  tx: BetterSqlite3.Database,
  ticketId: string,
  fingerprint: string,
): boolean {
  const row = tx
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM classification_audit
         WHERE ticket_id = ? AND signal_fingerprint = ?
       ) AS seen`,
    )
    .get(ticketId, fingerprint) as { seen: number };
  return row.seen === 1;
}

// ── decideAction ──────────────────────────────────────────────────────────────
// The action decision for one matched live row (done / open / watching). Shared by the primary
// lookup and the bridge lookup: the bridge only changes HOW the row is found, never the action
// it resolves to. `bridge` flags the result for createTicket's in-tx identity migration.
function decideAction(
  input: DedupInput,
  existing: DedupRow,
  tx: BetterSqlite3.Database,
  bridge: boolean,
): DedupResult {
  // Match on a done ticket → EXISTS reopen gate. A genuinely new fingerprint (never recorded
  // against this ticket) reopens; a fingerprint we've already filed (a retry of the same event)
  // groups, leaving the ticket done. The carried-through severity on a reopen matches the legacy
  // contract — a re-open does NOT raise severity (only `updated` does, on open/watching).
  if (existing.status === 'done') {
    const reopened: DedupResult = {
      action: 'reopened',
      existingId: existing.id,
      severityToStore: existing.severity,
      bridge,
    };

    // Null fingerprint → no audit block → legacy unconditional reopen. This is the contract for
    // non-Gmail provenances (sentry-alert, stripe-webhook, status-poll, manual, …) that carry no
    // classification_audit, so EXISTS would never find a row and every refire must reopen.
    if (input.signal_fingerprint === null) {
      return reopened;
    }

    // Timing invariant: writeAuditRow fires AFTER resolveDedup in the create tx (tickets.ts).
    // A first-time event has no current-event row yet → EXISTS = FALSE → reopened (correct).
    // A retry has a prior-run audit row → EXISTS = TRUE → grouped (correct).
    // Do NOT move writeAuditRow before this call — it would cause first-time events to self-match.
    const seen = fingerprintSeen(tx, existing.id, input.signal_fingerprint);
    if (seen) {
      return {
        action: 'grouped',
        existingId: existing.id,
        severityToStore: existing.severity,
        bridge,
      };
    }
    return reopened;
  }

  // Match on open|watching. The ONLY Phase-1 `updated` trigger: incoming severity strictly
  // higher than the stored value. Then raise the stored severity to the incoming value.
  if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]) {
    return {
      action: 'updated',
      existingId: existing.id,
      severityToStore: input.severity,
      bridge,
    };
  }

  // Every other open|watching match → grouped. Same-or-lower severity, body/title ignored in
  // Phase 1. severity is NOT lowered — keep the existing (higher-or-equal) stored value.
  return {
    action: 'grouped',
    existingId: existing.id,
    severityToStore: existing.severity,
    bridge,
  };
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
    return { action: 'created', existingId: null, severityToStore: input.severity, bridge: false };
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

  // Primary HIT → decide and return. The bridge is NEVER consulted on a primary hit (AC-14) —
  // not even when bridge_source_refs is provided. It is strictly a primary-miss fallback.
  if (existing) {
    return decideAction(input, existing, tx, false);
  }

  // ── Pre-fix compatibility bridge (FR-15/17, OQ-5, EC-1, AC-13) ───────────────
  // Primary thread-id miss. A pre-fix ticket was keyed on `messageId:ticket_type`, not
  // `threadId:ticket_type`, so the new thread-keyed lookup misses it. Compose each thread
  // message id into its candidate message-keyed dedup_key and look for one live match. Same
  // status set, same idx_ticket_dedup_key index, deterministic by oldest-created on ties.
  if (input.bridge_source_refs.length > 0) {
    const candidates = input.bridge_source_refs.map((msgId) =>
      computeDedupKey(msgId, input.ticket_type),
    );
    const placeholders = candidates.map(() => '?').join(', ');
    const bridged = tx
      .prepare(
        `SELECT id, status, severity FROM ticket
           WHERE dedup_key IN (${placeholders})
             AND status IN ('open', 'watching', 'done')
           ORDER BY created_at ASC
           LIMIT 1`,
      )
      .get(...candidates) as DedupRow | undefined;

    // Bridge HIT → same action decision as a primary hit, flagged bridge:true so createTicket
    // migrates the row to thread identity before applying the action.
    if (bridged) {
      return decideAction(input, bridged, tx, true);
    }
  }

  // No primary match and no bridge match → create.
  return { action: 'created', existingId: null, severityToStore: input.severity, bridge: false };
}
