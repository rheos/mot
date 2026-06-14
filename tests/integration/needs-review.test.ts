import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-NEEDS-REVIEW — the needs_review queue filter is wired at the query layer. A needs_review
// ticket round-trips through listTickets({needs_review:true}); flipping it off removes it.

const dbPath = setupTempDb('needsreview');
const { createTicket, patchTicket, listTickets } = await import('../../lib/tickets');

afterAll(() => cleanupTempDb(dbPath));

describe('AC-NEEDS-REVIEW — needs_review filter', () => {
  it('returns only needs_review=true tickets, and drops one when the flag is cleared', () => {
    const t1 = createTicket(
      createInput({ title: 'Low confidence', needs_review: true }) as never,
    );
    const t2 = createTicket(
      createInput({ title: 'Confident', needs_review: false }) as never,
    );

    const flagged = listTickets({
      needs_review: true,
      status: ['open'],
      includePrivate: true,
    });
    const ids = flagged.tickets.map((t) => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).not.toContain(t2.id);

    // PATCH the flag off.
    patchTicket(t1.id, { needs_review: false } as never);

    const after = listTickets({
      needs_review: true,
      status: ['open'],
      includePrivate: true,
    });
    expect(after.tickets.map((t) => t.id)).not.toContain(t1.id);
  });
});
