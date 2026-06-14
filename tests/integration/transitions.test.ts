import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// FR-LC-1 — status transition legality in patchTicket. Legal transitions apply; illegal ones
// throw a 422-shaped TicketError. (Zod already rejects 'archived' upstream; this layer guards
// the lifecycle graph.)

const dbPath = setupTempDb('transitions');
const { createTicket, patchTicket, TicketError } = await import('../../lib/tickets');

afterAll(() => cleanupTempDb(dbPath));

function isoFuture(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

describe('FR-LC-1 — status transition legality', () => {
  it('allows open → watching → snoozed → open', () => {
    const t = createTicket(createInput({ title: 'lifecycle' }) as never);
    expect(patchTicket(t.id, { status: 'watching' } as never).status).toBe('watching');
    expect(
      patchTicket(t.id, { status: 'snoozed', snoozed_until: isoFuture() } as never)
        .status,
    ).toBe('snoozed');
    const reopened = patchTicket(t.id, { status: 'open' } as never);
    expect(reopened.status).toBe('open');
    // Leaving snoozed cleared snoozed_until.
    expect(reopened.snoozed_until).toBeNull();
  });

  it('rejects an illegal transition (watching → open) with a 422 TicketError', () => {
    const t = createTicket(createInput({ title: 'illegal' }) as never);
    patchTicket(t.id, { status: 'watching' } as never);
    try {
      patchTicket(t.id, { status: 'open' } as never);
      throw new Error('expected TicketError');
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      expect((err as InstanceType<typeof TicketError>).status).toBe(422);
      expect((err as Error).message).toContain('Invalid status transition');
    }
  });

  it('done → open clears closed_at on the explicit re-open path', () => {
    const t = createTicket(createInput({ title: 'reopen' }) as never);
    const done = patchTicket(t.id, { status: 'done' } as never);
    expect(done.closed_at).not.toBeNull();
    const reopened = patchTicket(t.id, { status: 'open' } as never);
    expect(reopened.status).toBe('open');
    expect(reopened.closed_at).toBeNull();
  });

  it('404s a patch to a missing ticket', () => {
    try {
      patchTicket('does-not-exist', { title: 'x' } as never);
      throw new Error('expected TicketError');
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      expect((err as InstanceType<typeof TicketError>).status).toBe(404);
    }
  });
});
