import { describe, it, expect, afterAll } from 'vitest';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-PRIVATE (route half) — single-user visibility model through the HTTP handlers.
// The API key and a session cookie are BOTH privileged credentials (the key only ever goes to
// Taylor/Rheo), so both see private rows end-to-end; only a fully unauthenticated request is
// refused. This encodes the 2026-06-21 decision (commit 5240a21, `isSessionRequest` true for any
// authenticated request): no reason to hide tickets from the key-only path — that IS the LLM/MCP
// path that helps with those very tickets. The `private` flag is retained (a future gate could
// consume the data-layer includePrivate param) but gates nothing between authenticated callers.
// The data-layer half (the includePrivate parameter itself) is private-gate.test.ts.

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

describe('AC-PRIVATE — private visibility through the route handlers', () => {
  it('shows a private ticket to BOTH an API-key caller and a session (single-user: the key is privileged)', async () => {
    // 1. POST a private ticket with the API key → 201.
    const created = await ticketsRoute.POST(
      post(postBody({ title: 'Sealed', ministry: 'education', private: true })),
    );
    expect(created.status).toBe(201);
    const t1 = (await created.json()) as { id: string };

    // 2. GET /tickets with API key only (no session) → T1 PRESENT (the key is privileged).
    const keyList = await ticketsRoute.GET(getList());
    expect(keyList.status).toBe(200);
    const keyBody = (await keyList.json()) as { tickets: { id: string }[] };
    expect(keyBody.tickets.map((t) => t.id)).toContain(t1.id);

    // 3. GET /tickets/:id with API key only → 200 (no gate between authenticated callers).
    const keyOne = await ticketIdRoute.GET(getOne(t1.id), { params: Promise.resolve({ id: t1.id }) });
    expect(keyOne.status).toBe(200);

    // 4. GET /tickets with a valid session → T1 present (identical visibility).
    const sessList = await ticketsRoute.GET(getList(auth.sessionCookie));
    const sessBody = (await sessList.json()) as { tickets: { id: string }[] };
    expect(sessBody.tickets.map((t) => t.id)).toContain(t1.id);

    // 5. GET /tickets/:id with a valid session → 200.
    const sessOne = await ticketIdRoute.GET(getOne(t1.id, auth.sessionCookie), {
      params: Promise.resolve({ id: t1.id }),
    });
    expect(sessOne.status).toBe(200);
  });

  it('rejects an unauthenticated request (no key, no session) with 401', async () => {
    const anon = new Request('http://localhost/api/tickets?status=open', { method: 'GET' });
    const res = await ticketsRoute.GET(anon);
    expect(res.status).toBe(401);
  });
});
