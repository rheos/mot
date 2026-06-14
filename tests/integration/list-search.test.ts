import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// listTickets keyword search (FR-API-3 q) — proves the FTS JOIN + the phrase-quoting that the
// P3 handoff requires. A hyphenated token like "overdue-invoice" must be searchable (it would
// otherwise trip the FTS5 query grammar and error). The private gate composes with FTS.

const dbPath = setupTempDb('search');
const { createTicket, listTickets } = await import('../../lib/tickets');

afterAll(() => cleanupTempDb(dbPath));

describe('listTickets — FTS keyword search', () => {
  it('matches a hyphenated body term without an FTS grammar error', () => {
    createTicket(
      createInput({
        title: 'Billing issue',
        body: 'An overdue-invoice from a customer needs attention.',
      }) as never,
    );
    createTicket(
      createInput({ title: 'Unrelated', body: 'Nothing to see here.' }) as never,
    );

    // The hyphenated token is quoted into an FTS5 phrase by the data layer — no thrown error.
    const result = listTickets({ q: 'overdue-invoice', includePrivate: true, status: [] });
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].title).toBe('Billing issue');
  });

  it('search composes with the private gate', () => {
    createTicket(
      createInput({
        title: 'Secret billing',
        body: 'A private overdue-invoice for education.',
        private: true,
        ministry: 'education',
      }) as never,
    );

    // includePrivate=false → the private match is excluded even though it matches the term.
    const guarded = listTickets({
      q: 'overdue-invoice',
      includePrivate: false,
      status: [],
    });
    expect(guarded.tickets.every((t) => !t.private)).toBe(true);
    expect(guarded.tickets.map((t) => t.title)).not.toContain('Secret billing');

    // includePrivate=true → both the public and private matches return.
    const all = listTickets({ q: 'overdue-invoice', includePrivate: true, status: [] });
    expect(all.tickets.map((t) => t.title)).toContain('Secret billing');
  });
});
