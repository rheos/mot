import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-PRIVATE (data-layer half) — the private gate is enforced IN THE SQL. listTickets and
// getTicket take includePrivate; when false (API-key-only request, no session) private rows are
// never returned and a private getTicket returns null (the route handler turns that into 404).
// The HTTP/session half is the route-handler chunk's (Prompt 8); here we prove the SQL gate.

const dbPath = setupTempDb('private');
const { createTicket, listTickets, getTicket } = await import('../../lib/tickets');

afterAll(() => cleanupTempDb(dbPath));

describe('AC-PRIVATE — private gate in the data layer', () => {
  it('hides private rows from list + getTicket when includePrivate is false', () => {
    const priv = createTicket(
      createInput({ title: 'Education note', ministry: 'education', private: true }) as never,
    );
    const pub = createTicket(createInput({ title: 'Public item' }) as never);

    // includePrivate=false → private row absent, public row present.
    const guarded = listTickets({ status: ['open'], includePrivate: false });
    const guardedIds = guarded.tickets.map((t) => t.id);
    expect(guardedIds).not.toContain(priv.id);
    expect(guardedIds).toContain(pub.id);

    // getTicket on the private id without privilege → null (caller → 404).
    expect(getTicket(priv.id, false)).toBeNull();
    // Public ticket is fetchable either way.
    expect(getTicket(pub.id, false)).not.toBeNull();
  });

  it('returns private rows when includePrivate is true (session present)', () => {
    const all = listTickets({ status: ['open'], includePrivate: true });
    // Both the private and public tickets are now visible.
    expect(all.tickets.some((t) => t.private)).toBe(true);

    const privId = all.tickets.find((t) => t.private)!.id;
    const fetched = getTicket(privId, true);
    expect(fetched).not.toBeNull();
    expect(fetched!.private).toBe(true);
  });
});
