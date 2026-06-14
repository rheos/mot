import { describe, it, expect, afterAll } from 'vitest';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-PRIVATE (route half) — the private gate enforced end-to-end through the HTTP handlers.
// API-key-only requests (no session cookie) never see private rows in the list and get 404
// (not 403) on a private :id. The same requests with a sealed session cookie see everything.
// The data-layer half is private-gate.test.ts (Prompt 6); this is the session/HTTP layer.

const auth = await setupRouteDb('private-routes');
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

function getList(cookie?: string): Request {
  return new Request('http://localhost/api/tickets?status=open', {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : { ...auth.authHeader },
  });
}

function getOne(id: string, cookie?: string): Request {
  return new Request(`http://localhost/api/tickets/${id}`, {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : { ...auth.authHeader },
  });
}

describe('AC-PRIVATE — private gate through the route handlers', () => {
  it('hides a private ticket from API-key-only callers (list + 404), shows it to a session', async () => {
    // 1. POST a private ticket with the API key → 201.
    const created = await ticketsRoute.POST(
      post(postBody({ title: 'Sealed', ministry: 'education', private: true })),
    );
    expect(created.status).toBe(201);
    const t1 = (await created.json()) as { id: string };

    // 2. GET /tickets with API key only (no session) → T1 absent.
    const keyList = await ticketsRoute.GET(getList());
    expect(keyList.status).toBe(200);
    const keyBody = (await keyList.json()) as { tickets: { id: string }[] };
    expect(keyBody.tickets.map((t) => t.id)).not.toContain(t1.id);

    // 3. GET /tickets/:id with API key only → 404 (NOT 403, no existence leak).
    const keyOne = await ticketIdRoute.GET(getOne(t1.id), { params: { id: t1.id } });
    expect(keyOne.status).toBe(404);

    // 4. GET /tickets with a valid session → T1 present.
    const sessList = await ticketsRoute.GET(getList(auth.sessionCookie));
    const sessBody = (await sessList.json()) as { tickets: { id: string }[] };
    expect(sessBody.tickets.map((t) => t.id)).toContain(t1.id);

    // 5. GET /tickets/:id with a valid session → 200.
    const sessOne = await ticketIdRoute.GET(getOne(t1.id, auth.sessionCookie), {
      params: { id: t1.id },
    });
    expect(sessOne.status).toBe(200);
  });

  it('rejects an unauthenticated request (no key, no session) with 401', async () => {
    const anon = new Request('http://localhost/api/tickets?status=open', { method: 'GET' });
    const res = await ticketsRoute.GET(anon);
    expect(res.status).toBe(401);
  });
});
