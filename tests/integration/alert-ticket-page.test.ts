import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb } from './_helpers';

// fileAlert's DELIVERY contract (lib/alert-ticket.ts) — the half that was missing entirely until
// #39. sendTelegramNotify used to be reachable only from app/api/tickets/route.ts, so every
// in-process monitor filed a critical ticket and told nobody: maintainer-health never paged once
// between #5 and #39, while viralvision's disk guardrail did, purely because it POSTs over HTTP.
//
// So these tests assert the thing the old comments merely claimed: a page actually leaves the
// building, exactly once per incident.

const sendTelegramNotify = vi.fn(async (_text: string) => {});
vi.mock('../../lib/notify', () => ({
  sendTelegramNotify: (text: string) => sendTelegramNotify(text),
}));

const dbPath = setupTempDb('alert-ticket-page');
const { fileAlert, clearAlert } = await import('../../lib/alert-ticket');

beforeEach(() => {
  sendTelegramNotify.mockClear();
  sendTelegramNotify.mockImplementation(async () => {});
});

afterAll(() => {
  cleanupTempDb(dbPath);
});

function alert(sourceRef: string, severity: 'critical' | 'high' = 'critical') {
  fileAlert({ sourceRef, severity, title: `${sourceRef} is failing`, body: 'the body' });
}

describe('fileAlert — paging', () => {
  it('pages on the first occurrence, with the title, body and a link to the ticket', () => {
    alert('test:first');

    expect(sendTelegramNotify).toHaveBeenCalledTimes(1);
    const text = sendTelegramNotify.mock.calls[0][0];
    expect(text).toContain('[CRITICAL]');
    expect(text).toContain('test:first is failing');
    expect(text).toContain('the body');
    expect(text).toMatch(/\/tickets\/[0-9a-f]{8}/);
  });

  it('does NOT page on a repeat of the same unresolved condition', () => {
    alert('test:repeat');
    expect(sendTelegramNotify).toHaveBeenCalledTimes(1);

    sendTelegramNotify.mockClear();
    alert('test:repeat');
    alert('test:repeat');
    alert('test:repeat');

    // event_count climbs; Robin's phone stays quiet. This is the whole reason the source_ref is
    // stable — five nights of the same outage must not be five pages.
    expect(sendTelegramNotify).not.toHaveBeenCalled();
  });

  it('pages again when a resolved condition comes back — that is a new incident', () => {
    alert('test:recur');
    sendTelegramNotify.mockClear();

    clearAlert('test:recur', 'resolved');
    expect(sendTelegramNotify).not.toHaveBeenCalled(); // recovery is not a page

    alert('test:recur'); // dedup reopens the closed ticket
    expect(sendTelegramNotify).toHaveBeenCalledTimes(1);
  });

  it('pages for a non-critical alert too — severity orders triage, it does not gate delivery', () => {
    alert('test:high', 'high');

    expect(sendTelegramNotify).toHaveBeenCalledTimes(1);
    expect(sendTelegramNotify.mock.calls[0][0]).toContain('[HIGH]');
  });
});

describe('fileAlert — delivery failures never reach the caller', () => {
  it('a rejected send does not throw out of fileAlert', () => {
    sendTelegramNotify.mockImplementation(async () => {
      throw new Error('telegram is down');
    });

    // fileAlert runs inside the nightly cron. A Telegram outage must not take the job down, and
    // must not lose the ticket either.
    expect(() => alert('test:send-fails')).not.toThrow();
  });

  it('the ticket is still filed when the page cannot be delivered', async () => {
    sendTelegramNotify.mockImplementation(async () => {
      throw new Error('telegram is down');
    });
    alert('test:ticket-survives');

    const { listTickets } = await import('../../lib/tickets');
    const filed = listTickets({ status: ['open'], includePrivate: true }).tickets.filter(
      (t) => t.source_ref === 'test:ticket-survives',
    );
    expect(filed).toHaveLength(1);
  });
});
