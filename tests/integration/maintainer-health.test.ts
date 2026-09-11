import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb } from './_helpers';

// Nightly maintainer failure monitoring (lib/maintainer-health.ts). This is the "arguably more
// important half" fix for the 2026-08-13→2026-09-11 outage: the workers themselves were failing
// every single night, but maintainer_status is pull-only, so nobody was ever told. reportWorkerHealth
// is the push side — it rides the SAME dedup identity (source_ref + ticket_type) createTicket already
// uses for external alerts (ViralVision's disk-guardrail, the Gmail intake routine), so a worker
// failing every night for weeks produces exactly ONE Telegram page (ticket CREATE) plus one ticket
// whose event_count climbs on every repeat failure — never a fresh page per night.

const dbPath = setupTempDb('maintainer-health');
const { reportWorkerHealth } = await import('../../lib/maintainer-health');
const { listTickets, getTicket } = await import('../../lib/tickets');

afterAll(() => {
  cleanupTempDb(dbPath);
});

function openInfraAlerts() {
  return listTickets({
    status: ['open', 'watching', 'snoozed'],
    ministry: ['works'],
    includePrivate: true,
  }).tickets.filter((t) => t.ticket_type === 'infra-alert');
}

describe('reportWorkerHealth', () => {
  it('ok:false files a critical infra-alert ticket keyed by maintainer:<worker>', () => {
    reportWorkerHealth('resolution', {
      ok: false,
      error: 'claude -p exited null: ',
      batches_failed: 52,
    });

    const tickets = openInfraAlerts().filter((t) => t.source_ref === 'maintainer:resolution');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].severity).toBe('critical');
    expect(tickets[0].ministry).toBe('works');
    expect(tickets[0].status).toBe('open');
    expect(tickets[0].body).toContain('claude -p exited null');
    expect(tickets[0].body).toContain('52');
  });

  it('a repeat ok:false failure dedups onto the SAME ticket (event_count climbs, no duplicate)', () => {
    reportWorkerHealth('dedup', { ok: false, error: 'boom 1', batches_failed: 3 });
    const first = openInfraAlerts().filter((t) => t.source_ref === 'maintainer:dedup');
    expect(first).toHaveLength(1);
    const firstId = first[0].id;
    const firstCount = first[0].event_count;

    reportWorkerHealth('dedup', { ok: false, error: 'boom 2', batches_failed: 4 });
    const second = openInfraAlerts().filter((t) => t.source_ref === 'maintainer:dedup');
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(firstId);
    expect(second[0].event_count).toBeGreaterThan(firstCount);
  });

  it('ok:true after a prior failure closes the existing ticket with a resolution comment', () => {
    reportWorkerHealth('profile', { ok: false, error: 'batch failure', batches_failed: 16 });
    const failing = openInfraAlerts().filter((t) => t.source_ref === 'maintainer:profile');
    expect(failing).toHaveLength(1);
    const ticketId = failing[0].id;

    reportWorkerHealth('profile', { ok: true, error: null });

    const withComments = getTicket(ticketId, true)!;
    expect(withComments.status).toBe('done');
    expect(
      withComments.comments.some((c) => c.body.includes('Resolved') && c.body.includes('profile')),
    ).toBe(true);
    // No lingering open infra-alert for this worker.
    expect(openInfraAlerts().some((t) => t.source_ref === 'maintainer:profile')).toBe(false);
  });

  it('ok:true with no prior failure is a no-op (no ticket created)', () => {
    reportWorkerHealth('autoconfirm', { ok: true, error: null });
    expect(openInfraAlerts().some((t) => t.source_ref === 'maintainer:autoconfirm')).toBe(false);
  });
});
