import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-EC8 (backend API half, route level) — wake-pending visible through GET /tickets without a
// sweep. ?wake_pending=true returns a past-due snoozed ticket; ?status=open does NOT, because
// the stored status is still 'snoozed' (no sweep mutated it). The data-layer half is
// wake-pending.ec8.test.ts (Prompt 6); this proves the route handler parses wake_pending and
// hands it to listTickets. The UI render half is the Mage's Playwright test (Prompt 11).

const auth = await setupRouteDb('wake-routes');
const ticketsRoute = await import('../../app/api/tickets/route');

afterAll(() => cleanupTempDb(auth.dbPath));

function post(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(bodyObj),
  });
}

async function getIds(query: string): Promise<string[]> {
  const res = await ticketsRoute.GET(
    new Request(`http://localhost/api/tickets?${query}`, {
      method: 'GET',
      headers: { Cookie: auth.sessionCookie },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tickets: { id: string }[] };
  return body.tickets.map((t) => t.id);
}

describe('AC-EC8 — wake_pending through GET /tickets', () => {
  it('returns a past-due snoozed ticket for wake_pending=true and excludes it from status=open', async () => {
    // 1. POST a ticket, then force it into a past-due snoozed state directly (validation rejects
    //    a past snoozed_until on PATCH; this mirrors a ticket snoozed earlier whose window
    //    has since elapsed — the AC-EC8 "no sweep has run" constraint).
    const created = await ticketsRoute.POST(post(postBody({ title: 'Wake me' })));
    expect(created.status).toBe(201);
    const t1 = ((await created.json()) as { id: string }).id;

    const c = new Database(auth.dbPath);
    try {
      c.prepare(
        "UPDATE ticket SET status = 'snoozed', snoozed_until = ? WHERE id = ?",
      ).run(new Date(Date.now() - 30 * 60_000).toISOString(), t1);
    } finally {
      c.close();
    }

    // 2. ?wake_pending=true → T1 present.
    expect(await getIds('wake_pending=true')).toContain(t1);

    // 3. ?status=open → T1 absent (still 'snoozed' in the DB — no sweep).
    expect(await getIds('status=open')).not.toContain(t1);
  });
});
