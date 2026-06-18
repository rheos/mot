// tests/integration/moi-ec2-silent-feed.test.ts
// AC-EC2 — silent-feed mechanism. A feed adapter with an expectedFrequency baseline files a
// silent-feed:high ticket when over-quiet. Tests the route-level contract (the ticket type is
// valid + deduplication works) that briefing.py exercises in production.
// The silent_feed_sweep() DECISION logic is unit-tested in bot/test_silent_feed.py (Prompt 06);
// this asserts the route/DB CONTRACT layer (the ticket persists + dedups). The two are complementary.
// Uses setupRouteDb / postBody from _helpers.ts (M3).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

const auth = await setupRouteDb('moi-ec2');
const ticketsRoute = await import('../../app/api/tickets/route');

afterAll(() => cleanupTempDb(auth.dbPath));

// Mirrors the exact body briefing.silent_feed_sweep() POSTs: provenance 'status-poll'
// (a valid Provenance enum member), ticket_type 'silent-feed', severity 'high',
// source_ref '<sourceId>:<window>'.
function silentFeedPost(sourceRef: string): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(
      postBody({
        title: 'Silent feed: gmail.intake returned no signals in 3d',
        ministry: 'commerce',
        ticket_type: 'silent-feed',
        severity: 'high',
        provenance: 'status-poll',
        source_ref: sourceRef,
        body: 'Feed gmail.intake returned no signals in the last 3d.',
      }),
    ),
  });
}

describe('AC-EC2 — silent-feed ticket mechanism', () => {
  it('silent-feed ticket files at high severity', async () => {
    const res = await ticketsRoute.POST(silentFeedPost('gmail.intake:3d'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: { severity: string; ticket_type: string } };
    expect(body.ticket.severity).toBe('high');
    expect(body.ticket.ticket_type).toBe('silent-feed');
  });

  it('re-filing the same source_ref groups (one row)', async () => {
    const res = await ticketsRoute.POST(silentFeedPost('gmail.intake:3d'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe('grouped');

    // dedup_key = `${source_ref}:${ticket_type}` (lib/dedup.computeDedupKey).
    const c = new Database(auth.dbPath);
    try {
      const count = (
        c
          .prepare("SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = 'gmail.intake:3d:silent-feed'")
          .get() as { n: number }
      ).n;
      expect(count).toBe(1);
    } finally {
      c.close();
    }
  });
});
