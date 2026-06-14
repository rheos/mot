import type BetterSqlite3 from 'better-sqlite3';
import { createId } from '@paralleldrive/cuid2';
import { nowIso } from './time';

// ── PATCH derived effects (FR-API-2a/2b, EC-ARCH-3) ───────────────────────────
// Both run INSIDE patchTicket's transaction (passed the same `tx`). Both are wired in Phase 1
// and fire on the first qualifying data; neither is a Phase-1 no-op by design — they no-op
// only because Phase 1 data (linked pairs, audit rows) doesn't exist yet.

// ── linkedTicketCascade (FR-API-2a) ───────────────────────────────────────────
// Called ONLY when a ticket's status transitions to `done`. If it has a linked_ticket_id,
// close that linked ticket too (one level — no recursion). EC-ARCH-3: a broken link (the
// linked id points at a ticket that does not exist) is logged and skipped — the PATCH still
// succeeds.
export function linkedTicketCascade(
  ticketId: string,
  tx: BetterSqlite3.Database,
): void {
  const ticket = tx
    .prepare('SELECT linked_ticket_id FROM ticket WHERE id = ?')
    .get(ticketId) as { linked_ticket_id: string | null } | undefined;
  if (!ticket?.linked_ticket_id) return;

  const linked = tx
    .prepare('SELECT id, status FROM ticket WHERE id = ?')
    .get(ticket.linked_ticket_id) as
    | { id: string; status: string }
    | undefined;

  if (!linked) {
    // EC-ARCH-3: broken link — log and continue, do NOT throw. The PATCH still succeeds.
    // eslint-disable-next-line no-console
    console.warn(
      `[MOT] linkedTicketCascade: broken link — linked_ticket_id=${ticket.linked_ticket_id} ` +
        `not found for ticket ${ticketId}. Skipping cascade.`,
    );
    return;
  }

  // Already done → nothing to cascade (avoids a redundant close + comment).
  if (linked.status === 'done') return;

  const now = nowIso();
  tx.prepare(
    `UPDATE ticket SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, linked.id);

  tx.prepare(
    `INSERT INTO comment (id, ticket_id, author, body, created_at)
       VALUES (?, ?, 'tuttle', ?, ?)`,
  ).run(
    createId(),
    linked.id,
    `auto-closed: linked ticket ${ticketId} closed`,
    now,
  );

  // One level only. We do NOT follow linked.linked_ticket_id — no recursive cascade (FR-API-2a).
}

// ── backfillCorrection (FR-API-2b) ────────────────────────────────────────────
// Called whenever a PATCH changes ministry and/or severity. Finds the latest
// classification_audit row for the ticket and writes the corrected_* ground-truth back. No
// audit row (manual ticket) → silent no-op. This is the only post-insert write to
// classification_audit.
export function backfillCorrection(
  ticketId: string,
  changes: { ministry?: string; severity?: string },
  tx: BetterSqlite3.Database,
): void {
  if (!changes.ministry && !changes.severity) return;

  const audit = tx
    .prepare(
      'SELECT id FROM classification_audit WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(ticketId) as { id: string } | undefined;

  // Manual ticket — no audit row — skip silently.
  if (!audit) return;

  const now = nowIso();
  const updates: Record<string, string> = { corrected_at: now };
  if (changes.ministry) updates.corrected_ministry = changes.ministry;
  if (changes.severity) updates.corrected_severity = changes.severity;

  const setClauses = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  tx.prepare(`UPDATE classification_audit SET ${setClauses} WHERE id = ?`).run(
    ...Object.values(updates),
    audit.id,
  );
}
