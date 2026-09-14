import { describe, it, expect, afterAll } from 'vitest';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// Session-OR-key write guard (FR-API-1, spec.md:1085) — the seam the API-key-only write tests
// never exercised. The UI mutates (manual create form, triage actions, comment box, re-assign)
// from the browser with ONLY the mot_session cookie and no Bearer key. A key-only guard would
// 401 every UI write — that was the seam bug. These tests drive POST and PATCH with a session
// cookie and NO Authorization header and assert they SUCCEED, and that a request carrying
// neither session nor key 401s. The key path is already covered by validation-routes.test.ts;
// this closes the session half of the OR.

const auth = await setupRouteDb('session-mutation');
const ticketsRoute = await import('../../app/api/tickets/route');
const ticketIdRoute = await import('../../app/api/tickets/[id]/route');

afterAll(() => cleanupTempDb(auth.dbPath));

// POST with ONLY the session cookie — no Authorization header.
function postWithSession(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: auth.sessionCookie },
    body: JSON.stringify(bodyObj),
  });
}

// PATCH with ONLY the session cookie — no Authorization header.
function patchWithSession(id: string, bodyObj: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: auth.sessionCookie },
    body: JSON.stringify(bodyObj),
  });
}

describe('session-driven mutation — POST/PATCH accept a session cookie, no Bearer key', () => {
  it('POST with a session cookie and NO key → 201 created', async () => {
    const res = await ticketsRoute.POST(
      postWithSession(postBody({ title: 'Session-created ticket' })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; action: string };
    expect(body.action).toBe('created');
    expect(body.id).toBeTruthy();
  });

  it('PATCH with a session cookie and NO key → 200', async () => {
    // Create the target via the session path too, then mutate it the same way.
    const created = await ticketsRoute.POST(
      postWithSession(postBody({ title: 'Session-patched ticket' })),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await ticketIdRoute.PATCH(
      patchWithSession(id, { status: 'watching' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: { status: string } };
    expect(body.ticket.status).toBe('watching');
  });

  it('POST with NEITHER session nor key → 401', async () => {
    const res = await ticketsRoute.POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('PATCH with NEITHER session nor key → 401', async () => {
    // First make a real ticket (with the key) so the 401 is the auth gate, not a 404.
    const created = await ticketsRoute.POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.authHeader },
        body: JSON.stringify(postBody({ title: '401 patch target' })),
      }),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await ticketIdRoute.PATCH(
      new Request(`http://localhost/api/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'watching' }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(401);
  });
});
