// tests/integration/moi-ec5-flood.test.ts
// AC-EC5 — flooding source collapses to one ticket + bumped event_count.
// Route-level test: 5 rapid re-files of the same source_ref:ticket_type at the SAME severity →
// 1 row, event_count=5. (Constant severity 'high' means each re-file resolves to 'grouped', not
// 'updated' — only a STRICTLY higher severity triggers 'updated', see lib/dedup.resolveDedup.)
// Mirrors dedup.ec1.test.ts Scenario A (data-layer) at the route level.
// Uses setupRouteDb / postBody from _helpers.ts (M3).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

const auth = await setupRouteDb('moi-ec5');
const ticketsRoute = await import('../../app/api/tickets/route');

afterAll(() => cleanupTempDb(auth.dbPath));

const FLOOD_SOURCE = 'sentry-project-abc';
const FLOOD_TYPE = 'app-error';

// provenance 'sentry-alert' is a valid Provenance enum member (lib/enums.ts).
function floodPost(): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(
      postBody({
        title: 'Sentry error in project abc',
        ministry: 'commerce',
        ticket_type: FLOOD_TYPE,
        severity: 'high',
        provenance: 'sentry-alert',
        source_ref: FLOOD_SOURCE,
        body: 'Error: something failed in project abc.',
      }),
    ),
  });
}

describe('AC-EC5 — flooding source dedup', () => {
  it('5 rapid re-files of the same source_ref:ticket_type → 1 row, event_count=5', async () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await ticketsRoute.POST(floodPost());
      results.push(res.status);
    }
    // First = 201 (created), remaining = 200 (grouped).
    expect(results[0]).toBe(201);
    expect(results.slice(1).every((s) => s === 200)).toBe(true);

    // dedup_key = `${source_ref}:${ticket_type}` (lib/dedup.computeDedupKey).
    const c = new Database(auth.dbPath);
    try {
      const row = c
        .prepare(
          'SELECT COUNT(*) AS n, MAX(event_count) AS max_ec FROM ticket WHERE dedup_key = ?',
        )
        .get(`${FLOOD_SOURCE}:${FLOOD_TYPE}`) as { n: number; max_ec: number };
      expect(row.n).toBe(1); // one row
      expect(row.max_ec).toBe(5); // event_count bumped to 5
    } finally {
      c.close();
    }
  });
});
