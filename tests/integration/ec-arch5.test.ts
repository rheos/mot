import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// EC-ARCH-5 — dedup on source_ref = null. Two POSTs with source_ref=null (manual tickets, no
// canonical id) must each create a distinct row regardless of ticket_type — dedup_key is null
// for both, so there is no identity to match on.

const dbPath = setupTempDb('ecarch5');
const { createTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

afterAll(() => cleanupTempDb(dbPath));

describe('EC-ARCH-5 — null source_ref always creates', () => {
  it('two null-source_ref POSTs create two rows with null dedup_key', () => {
    const a = createTicket(
      createInput({ source_ref: null, ticket_type: 'ad-hoc', title: 'Manual A' }) as never,
    );
    const b = createTicket(
      createInput({ source_ref: null, ticket_type: 'ad-hoc', title: 'Manual B' }) as never,
    );

    expect(a.action).toBe('created');
    expect(b.action).toBe('created');
    expect(a.id).not.toBe(b.id);
    expect(a.ticket.dedup_key).toBeNull();
    expect(b.ticket.dedup_key).toBeNull();

    const c = conn();
    try {
      const n = (c.prepare('SELECT COUNT(*) AS n FROM ticket').get() as { n: number }).n;
      expect(n).toBe(2);
    } finally {
      c.close();
    }
  });
});
