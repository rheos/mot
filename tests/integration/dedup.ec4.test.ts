import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-EC4 — a done ticket that re-fires re-opens (does not duplicate). The dedup lookup includes
// status='done'; on a match it sets status=open, clears closed_at, bumps event_count.

const dbPath = setupTempDb('ec4');
const { createTicket, patchTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

afterAll(() => cleanupTempDb(dbPath));

describe('AC-EC4 — done ticket re-fires → reopened, not duplicate', () => {
  it('re-opens the same ticket, clears closed_at, one row', () => {
    // 1. POST → created.
    const created = createTicket(
      createInput({
        source_ref: 'dep-alert-99',
        ticket_type: 'security-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );
    expect(created.action).toBe('created');
    const t1 = created.id;

    // 2. PATCH status=done → closed_at set.
    const done = patchTicket(t1, { status: 'done' } as never);
    expect(done.status).toBe('done');
    expect(done.closed_at).not.toBeNull();

    // 3. Same source re-fires.
    const refire = createTicket(
      createInput({
        source_ref: 'dep-alert-99',
        ticket_type: 'security-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );

    // 4. reopened: same ticket, status=open, closed_at null, event_count=2.
    expect(refire.action).toBe('reopened');
    expect(refire.id).toBe(t1);
    expect(refire.ticket.status).toBe('open');
    expect(refire.ticket.closed_at).toBeNull();
    expect(refire.ticket.event_count).toBe(2);

    // 5. No second row.
    const c = conn();
    try {
      const n = (
        c
          .prepare('SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = ?')
          .get('dep-alert-99:security-alert') as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      c.close();
    }
  });
});
