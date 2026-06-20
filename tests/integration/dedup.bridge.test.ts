import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createId } from '@paralleldrive/cuid2';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// Pre-fix compatibility bridge — dual-key fallback + in-tx identity migration.
// FR-15/17, Architecture OQ-5, EC-1, AC-13/14/15.
//
// Before the intake-skill fix, a Gmail ticket was keyed `messageId:ticket_type`. After the fix
// the skill sends `source_ref = threadId`, so the primary `threadId:ticket_type` lookup MISSES
// the pre-fix ticket. The bridge composes each thread message id into a candidate
// `messageId:ticket_type` key, finds the pre-fix ticket, and migrates it to thread identity
// inside the same create tx — so no duplicate is created and the next refire hits the primary
// lookup (the bridge is never re-entered).

const dbPath = setupTempDb('bridge');
const { createTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

// Insert a bare message-keyed `done` ticket directly (dedup_key = msgId:ticket_type) and return
// its id. Bypasses createTicket so the test controls exactly which audit rows exist.
function seedMessageKeyedDoneTicket(
  c: Database.Database,
  msgId: string,
  ticketType: string,
): string {
  const id = createId();
  const now = '2026-06-19T00:00:00.000Z';
  c.prepare(
    `INSERT INTO ticket (
        id, title, ministry, status, severity, ticket_type, provenance,
        source_ref, dedup_key, body, private, needs_review, event_count,
        snoozed_until, blocked_note, linked_ticket_id, created_at, updated_at, closed_at
      ) VALUES (?, 'Pre-fix seeded', 'works', 'done', 'normal', ?, 'gmail-parse',
        ?, ?, 'seed body', 0, 0, 1, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(id, ticketType, msgId, `${msgId}:${ticketType}`, now, now, now);
  return id;
}

function ticketRow(c: Database.Database, id: string): Record<string, unknown> {
  return c.prepare('SELECT * FROM ticket WHERE id = ?').get(id) as Record<string, unknown>;
}

function rowCountForType(c: Database.Database, ticketType: string): number {
  return (
    c
      .prepare('SELECT COUNT(*) AS n FROM ticket WHERE ticket_type = ?')
      .get(ticketType) as { n: number }
  ).n;
}

afterAll(() => cleanupTempDb(dbPath));

describe('AC-13 — bridge hit → migrate + EXISTS-gated action', () => {
  const TICKET_TYPE = 'school-comm';
  const MSG_ID = 'msg-ac13-original';
  const NEW_MSG_ID = 'msg-ac13-reply';
  const THREAD_ID = 'thread-ac13';

  it('primary misses, bridge finds the message-keyed ticket, migrates it, EXISTS-gated reopen, bridged:true, no duplicate', () => {
    const c = conn();
    let seededId: string;
    try {
      // Pre-fix ticket: keyed on the ORIGINAL message id, done. No audit rows → a new fingerprint
      // is genuinely unseen → the done-branch EXISTS gate resolves reopened.
      seededId = seedMessageKeyedDoneTicket(c, MSG_ID, TICKET_TYPE);

      // Sanity: the primary thread-keyed key does NOT exist yet.
      const primary = c
        .prepare('SELECT id FROM ticket WHERE dedup_key = ?')
        .get(`${THREAD_ID}:${TICKET_TYPE}`);
      expect(primary).toBeUndefined();
    } finally {
      c.close();
    }

    // New reply on the thread: source_ref = thread id (primary miss), bridge_source_refs carries
    // the original message id (so the bridge finds the pre-fix ticket) + a new message id.
    const result = createTicket(
      createInput({
        source_ref: THREAD_ID,
        ticket_type: TICKET_TYPE,
        ministry: 'education',
        severity: 'normal',
        provenance: 'gmail-parse',
        bridge_source_refs: [MSG_ID, NEW_MSG_ID],
        classification_audit: {
          signal_fingerprint: 'ac13-new-fp',
          model_version: 'v1',
          prompt_hash: 'ph-ac13',
          confidence: 0.9,
        },
      }) as never,
    );

    // Acts on the SAME pre-fix ticket (no new row created).
    expect(result.id).toBe(seededId!);
    // New fingerprint, no prior audit row → EXISTS FALSE → reopened.
    expect(result.action).toBe('reopened');
    expect(result.ticket.status).toBe('open');
    // Response carries the bridge marker.
    expect(result.bridged).toBe(true);

    const c2 = conn();
    try {
      // Identity rewritten to the thread in the same tx.
      const row = ticketRow(c2, seededId!);
      expect(row.source_ref).toBe(THREAD_ID);
      expect(row.dedup_key).toBe(`${THREAD_ID}:${TICKET_TYPE}`);

      // Exactly one ticket of this type exists — bridge migrated, did not duplicate.
      expect(rowCountForType(c2, TICKET_TYPE)).toBe(1);

      // A migration system comment, authored tuttle, naming the old→new keys.
      const comments = c2
        .prepare(
          "SELECT author, body FROM comment WHERE ticket_id = ? ORDER BY created_at ASC",
        )
        .all(seededId!) as { author: string; body: string }[];
      const migration = comments.find((cm) =>
        cm.body.includes('Thread identity migrated'),
      );
      expect(migration).toBeDefined();
      expect(migration!.author).toBe('tuttle');
      expect(migration!.body).toContain(`${MSG_ID}:${TICKET_TYPE}`);
      expect(migration!.body).toContain(`${THREAD_ID}:${TICKET_TYPE}`);
    } finally {
      c2.close();
    }
  });

  it('AC-14 — after migration, the primary lookup wins; the bridge is never re-entered', () => {
    // Put the (now thread-keyed) ticket back to done so a refire would visibly act on it.
    const c = conn();
    try {
      c.prepare("UPDATE ticket SET status = 'done', closed_at = ? WHERE dedup_key = ?").run(
        '2026-06-19T01:00:00.000Z',
        `${THREAD_ID}:${TICKET_TYPE}`,
      );
    } finally {
      c.close();
    }

    // A genuinely-new reply on the SAME thread: new message, new fingerprint. The primary
    // thread-keyed lookup now matches directly — bridge_source_refs is still supplied but must
    // NOT be consulted (and even the original MSG_ID no longer exists as a dedup_key).
    const refire = createTicket(
      createInput({
        source_ref: THREAD_ID,
        ticket_type: TICKET_TYPE,
        ministry: 'education',
        severity: 'normal',
        provenance: 'gmail-parse',
        bridge_source_refs: [MSG_ID, NEW_MSG_ID, 'msg-ac14-third'],
        classification_audit: {
          signal_fingerprint: 'ac14-new-fp',
          model_version: 'v1',
          prompt_hash: 'ph-ac14',
          confidence: 0.9,
        },
      }) as never,
    );

    // Primary match on a done ticket with a brand-new fingerprint → EXISTS FALSE → reopened.
    expect(refire.action).toBe('reopened');
    expect(refire.ticket.status).toBe('open');
    // The bridge was NOT used — no bridged marker.
    expect(refire.bridged).toBeUndefined();

    // Still exactly one ticket; no second migration comment was added.
    const c2 = conn();
    try {
      expect(rowCountForType(c2, TICKET_TYPE)).toBe(1);
      const migrationComments = (
        c2
          .prepare(
            "SELECT COUNT(*) AS n FROM comment c JOIN ticket t ON c.ticket_id = t.id " +
              "WHERE t.ticket_type = ? AND c.body LIKE 'Thread identity migrated%'",
          )
          .get(TICKET_TYPE) as { n: number }
      ).n;
      expect(migrationComments).toBe(1); // only the one from AC-13, none added on the refire
    } finally {
      c2.close();
    }
  });
});

describe('EC-1 — pre-fix done ticket, genuine new reply → migrate + reopen, no duplicate', () => {
  it('migrates to thread identity, reopens, and leaves exactly one ticket of this type', () => {
    const TICKET_TYPE = 'bill-due';
    const MSG_ID = 'msg-ec1-original';
    const THREAD_ID = 'thread-ec1';

    const c = conn();
    try {
      seedMessageKeyedDoneTicket(c, MSG_ID, TICKET_TYPE);
    } finally {
      c.close();
    }

    const result = createTicket(
      createInput({
        source_ref: THREAD_ID,
        ticket_type: TICKET_TYPE,
        ministry: 'plenty',
        severity: 'normal',
        provenance: 'gmail-parse',
        bridge_source_refs: [MSG_ID],
        classification_audit: {
          signal_fingerprint: 'ec1-new-fp',
          model_version: 'v1',
          prompt_hash: 'ph-ec1',
          confidence: 0.9,
        },
      }) as never,
    );

    expect(result.action).toBe('reopened');
    expect(result.ticket.status).toBe('open');
    expect(result.bridged).toBe(true);

    const c2 = conn();
    try {
      const row = ticketRow(c2, result.id);
      expect(row.source_ref).toBe(THREAD_ID);
      expect(row.dedup_key).toBe(`${THREAD_ID}:${TICKET_TYPE}`);
      // Only one ticket for this type after the call — no duplicate.
      expect(rowCountForType(c2, TICKET_TYPE)).toBe(1);
    } finally {
      c2.close();
    }
  });
});
