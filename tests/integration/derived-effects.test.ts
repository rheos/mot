import { describe, it, expect, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createId } from '@paralleldrive/cuid2';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// Prompt 7 — PATCH derived effects (FR-API-2a/2b, EC-ARCH-3).
//   1. linked-ticket auto-close cascade fires on transition to done.
//   2. cascade is ONE level only (no recursion).
//   3. broken link (EC-ARCH-3) — PATCH still succeeds, no crash, warning logged.
//   4. corrected_* back-fill when an audit row exists.
//   5. back-fill is a silent no-op when there is no audit row (manual ticket).

const dbPath = setupTempDb('derived');
const { createTicket, patchTicket } = await import('../../lib/tickets');
const { getDb } = await import('../../db/client');

function conn(): Database.Database {
  return new Database(dbPath);
}

afterAll(() => cleanupTempDb(dbPath));

describe('linkedTicketCascade (FR-API-2a, EC-ARCH-3)', () => {
  it('closes the linked ticket and adds an auto-closed comment', () => {
    const t1 = createTicket(createInput({ title: 'Parent' }) as never);
    const t2 = createTicket(createInput({ title: 'Linked child' }) as never);

    patchTicket(t1.id, { linked_ticket_id: t2.id } as never);
    patchTicket(t1.id, { status: 'done' } as never);

    const c = conn();
    try {
      const child = c.prepare('SELECT status FROM ticket WHERE id = ?').get(t2.id) as {
        status: string;
      };
      expect(child.status).toBe('done');

      const comment = c
        .prepare(
          "SELECT body FROM comment WHERE ticket_id = ? AND body LIKE 'auto-closed:%'",
        )
        .get(t2.id) as { body: string } | undefined;
      expect(comment?.body).toContain('auto-closed');
    } finally {
      c.close();
    }
  });

  it('cascades one level only — does not follow the child link', () => {
    const t1 = createTicket(createInput({ title: 'A' }) as never);
    const t2 = createTicket(createInput({ title: 'B' }) as never);
    const t3 = createTicket(createInput({ title: 'C' }) as never);

    patchTicket(t1.id, { linked_ticket_id: t2.id } as never);
    patchTicket(t2.id, { linked_ticket_id: t3.id } as never);

    patchTicket(t1.id, { status: 'done' } as never);

    const c = conn();
    try {
      const b = c.prepare('SELECT status FROM ticket WHERE id = ?').get(t2.id) as {
        status: string;
      };
      const cc = c.prepare('SELECT status FROM ticket WHERE id = ?').get(t3.id) as {
        status: string;
      };
      expect(b.status).toBe('done'); // one level fired
      expect(cc.status).toBe('open'); // second level did NOT
    } finally {
      c.close();
    }
  });

  it('EC-ARCH-3: a broken link does not crash; PATCH succeeds; a warning is logged', () => {
    const t1 = createTicket(createInput({ title: 'Has a broken link' }) as never);
    const phantom = createId(); // a well-formed cuid that was never inserted

    // Seed the broken link directly on the SAME connection the data layer uses. Phase 1 has NO
    // delete path, and the linked_ticket_id FK (foreign_keys=ON) rejects pointing at a
    // never-inserted id through the normal PATCH path — so the only way to reach the "linked
    // ticket missing" state the cascade guards against is to seed it directly (the spec's
    // EC-ARCH-3 test note: "seed linked_ticket_id with a never-existed id"). We toggle the FK
    // pragma off on the live connection just for the seed, then back on. This proves the
    // cascade's broken-link safety (for the future delete path); the FK is the Phase-1 guard
    // against ever reaching this state via the API.
    {
      const live = getDb();
      live.pragma('foreign_keys = OFF');
      live.prepare('UPDATE ticket SET linked_ticket_id = ? WHERE id = ?').run(phantom, t1.id);
      live.pragma('foreign_keys = ON');
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let result;
    let warnedMessages: string[] = [];
    try {
      result = patchTicket(t1.id, { status: 'done' } as never);
      // Capture before mockRestore() clears the recorded calls.
      warnedMessages = warn.mock.calls.map((args) => String(args[0]));
    } finally {
      warn.mockRestore();
    }

    expect(result.status).toBe('done'); // PATCH still succeeded
    expect(warnedMessages.length).toBeGreaterThan(0); // broken-link warning emitted
    expect(warnedMessages.join('\n')).toContain('broken link');
  });
});

describe('backfillCorrection (FR-API-2b)', () => {
  it('writes corrected_* onto the latest audit row when ministry changes', () => {
    // Create a ticket WITH a classification_audit block so an audit row exists.
    const t = createTicket(
      createInput({
        title: 'Classified ticket',
        source_ref: 'audit-src-1',
        ticket_type: 'infra-alert',
        ministry: 'works',
        classification_audit: {
          signal_fingerprint: 'fp-1',
          model_version: 'v1',
          prompt_hash: null,
          confidence: 0.4,
        },
      }) as never,
    );

    patchTicket(t.id, { ministry: 'commerce' } as never);

    const c = conn();
    try {
      const audit = c
        .prepare(
          'SELECT corrected_ministry, corrected_at FROM classification_audit WHERE ticket_id = ?',
        )
        .get(t.id) as { corrected_ministry: string | null; corrected_at: string | null };
      expect(audit.corrected_ministry).toBe('commerce');
      expect(audit.corrected_at).not.toBeNull();
    } finally {
      c.close();
    }
  });

  it('is a silent no-op when the ticket has no audit row (manual ticket)', () => {
    const t = createTicket(createInput({ title: 'Manual, no audit' }) as never);

    // No throw, and the audit table stays empty for this ticket.
    expect(() => patchTicket(t.id, { ministry: 'commerce' } as never)).not.toThrow();

    const c = conn();
    try {
      const n = (
        c
          .prepare('SELECT COUNT(*) AS n FROM classification_audit WHERE ticket_id = ?')
          .get(t.id) as { n: number }
      ).n;
      expect(n).toBe(0);
    } finally {
      c.close();
    }
  });
});
