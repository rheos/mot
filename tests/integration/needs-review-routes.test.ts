import { describe, it, expect, afterAll } from 'vitest';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-NEEDS-REVIEW (route half) — the needs_review queue filter wired at the route layer. A
// needs_review ticket round-trips through GET /tickets?needs_review=true; PATCHing the flag off
// drops it. The data-layer half is needs-review.test.ts (Prompt 6); this proves the handler
// parses the needs_review query param and that PATCH persists the cleared flag.

const auth = await setupRouteDb('needsreview-routes');
const ticketsRoute = await import('../../app/api/tickets/route');
const ticketIdRoute = await import('../../app/api/tickets/[id]/route');

afterAll(() => cleanupTempDb(auth.dbPath));

function post(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(bodyObj),
  });
}

async function reviewIds(): Promise<string[]> {
  const res = await ticketsRoute.GET(
    new Request('http://localhost/api/tickets?needs_review=true', {
      method: 'GET',
      headers: { Cookie: auth.sessionCookie },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tickets: { id: string }[] };
  return body.tickets.map((t) => t.id);
}

describe('AC-NEEDS-REVIEW — needs_review filter through the routes', () => {
  it('lists only needs_review tickets and drops one when PATCH clears the flag', async () => {
    // 1 + 2. POST a flagged and an unflagged ticket.
    const r1 = await ticketsRoute.POST(post(postBody({ title: 'Low conf', needs_review: true })));
    expect(r1.status).toBe(201);
    const t1 = ((await r1.json()) as { id: string; action: string });
    expect(t1.action).toBe('created');

    const r2 = await ticketsRoute.POST(post(postBody({ title: 'Confident', needs_review: false })));
    const t2 = ((await r2.json()) as { id: string });

    // 3. ?needs_review=true → T1 in, T2 out.
    const flagged = await reviewIds();
    expect(flagged).toContain(t1.id);
    expect(flagged).not.toContain(t2.id);

    // 4. PATCH the flag off → 200.
    const patched = await ticketIdRoute.PATCH(
      new Request(`http://localhost/api/tickets/${t1.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth.authHeader },
        body: JSON.stringify({ needs_review: false }),
      }),
      { params: { id: t1.id } },
    );
    expect(patched.status).toBe(200);

    // 5. ?needs_review=true → T1 gone.
    expect(await reviewIds()).not.toContain(t1.id);
  });
});
