import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// reportWorkerHealth must NEVER throw — a ticket-filing failure is exactly the kind of secondary
// fault that must not take down the nightly cron it's monitoring. This mocks lib/tickets entirely
// (unlike maintainer-health.test.ts's real-DB dedup/close coverage) so every call throws, proving
// the try/catch around the whole body actually holds.

const createTicket = vi.fn((_input?: unknown) => {
  throw new Error('db is down');
});
const findOpenTicketBySourceRef = vi.fn((_sourceRef?: unknown, _ticketType?: unknown) => {
  throw new Error('db is down');
});
const patchTicket = vi.fn();
vi.mock('../../lib/tickets', () => ({
  createTicket: (input: unknown) => createTicket(input),
  findOpenTicketBySourceRef: (sourceRef: unknown, ticketType: unknown) =>
    findOpenTicketBySourceRef(sourceRef, ticketType),
  patchTicket: (id: unknown, input: unknown) => patchTicket(id, input),
}));

const { reportWorkerHealth } = await import('../../lib/maintainer-health');

let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

describe('reportWorkerHealth — failsafe', () => {
  it('a createTicket failure (ok:false path) is caught and logged, never thrown', () => {
    expect(() => reportWorkerHealth('resolution', { ok: false, error: 'x' })).not.toThrow();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('[MOT/maintainer-health] failed to report resolution health'),
      ),
    ).toBe(true);
  });

  it('a findOpenTicketBySourceRef failure (ok:true path) is caught and logged, never thrown', () => {
    expect(() => reportWorkerHealth('dedup', { ok: true, error: null })).not.toThrow();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('[MOT/maintainer-health] failed to report dedup health'),
      ),
    ).toBe(true);
  });
});
