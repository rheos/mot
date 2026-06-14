import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-EC8 (backend half) — wake-pending visible without a sweep. listTickets({wake_pending:true})
// returns past-due snoozed tickets; those same tickets are absent from a status=open query
// because their stored status is still 'snoozed' (no sweep has run). The UI render assertion is
// the Mage's Playwright half.

const dbPath = setupTempDb('ec8');
const { createTicket, patchTicket, listTickets } = await import('../../lib/tickets');

afterAll(() => cleanupTempDb(dbPath));

function isoMinutesFromNow(min: number): string {
  return new Date(Date.now() + min * 60_000).toISOString();
}

describe('AC-EC8 — wake-pending query', () => {
  it('returns past-due snoozed tickets and excludes them from status=open', () => {
    // Create open, then snooze into the future (legal), then force snoozed_until into the past
    // directly (the snooze itself can't be set to the past — EC-ARCH-4 rejects it — but a
    // ticket snoozed earlier becomes past-due as time passes; we simulate that end state).
    const created = createTicket(
      createInput({ title: 'Snoozed item', ministry: 'flow' }) as never,
    );
    patchTicket(created.id, {
      status: 'snoozed',
      snoozed_until: isoMinutesFromNow(60),
    } as never);

    // Make it past-due (30 minutes ago).
    patchTicketDirectPastDue(created.id);

    // wake_pending=true returns it.
    const pending = listTickets({ wake_pending: true, includePrivate: true });
    expect(pending.tickets.map((t) => t.id)).toContain(created.id);
    expect(pending.total).toBe(1);

    // status=open does NOT return it (status is still 'snoozed' in the DB — no sweep).
    const open = listTickets({ status: ['open'], includePrivate: true });
    expect(open.tickets.map((t) => t.id)).not.toContain(created.id);
  });
});

// Snooze_until in the past is rejected by validation, so to reach the past-due state we set it
// directly on the DB (mirrors a ticket snoozed earlier whose window has since elapsed).
function patchTicketDirectPastDue(id: string): void {
  const c = new Database(process.env.DATABASE_URL as string);
  try {
    c.prepare('UPDATE ticket SET snoozed_until = ? WHERE id = ?').run(
      new Date(Date.now() - 30 * 60_000).toISOString(),
      id,
    );
  } finally {
    c.close();
  }
}
