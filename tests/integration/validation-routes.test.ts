import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-VALIDATION (route half) — the Zod boundary enforced END-TO-END through the handlers. The
// pure-unit schema tests live in validation.test.ts (Prompt 5); here we prove the POST/PATCH
// handlers return the right HTTP code and the FR-API-1 { error, fields[] } shape, and that the
// archived message survives the round-trip verbatim.

const auth = await setupRouteDb('validation-routes');
const ticketsRoute = await import('../../app/api/tickets/route');
const ticketIdRoute = await import('../../app/api/tickets/[id]/route');

afterAll(() => cleanupTempDb(auth.dbPath));

interface FieldError {
  field: string;
  message: string;
}
interface ValidationBody {
  error: string;
  fields: FieldError[];
}

function post(bodyObj: unknown): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(bodyObj),
  });
}

function patch(id: string, bodyObj: unknown): Request {
  return new Request(`http://localhost/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(bodyObj),
  });
}

let liveId: string;

beforeAll(async () => {
  // A real open ticket to PATCH against (so a 422 is the validation gate, not a 404).
  const res = await ticketsRoute.POST(post(postBody({ title: 'Patch target' })));
  liveId = ((await res.json()) as { id: string }).id;
});

describe('AC-VALIDATION — POST /tickets through the handler', () => {
  it('1. missing title → 422 with field title', async () => {
    const { title: _omit, ...noTitle } = postBody();
    const res = await ticketsRoute.POST(post(noTitle));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.error).toBe('validation_failed');
    expect(body.fields.some((f) => f.field === 'title')).toBe(true);
  });

  it('2. invalid ministry → 422 with field ministry', async () => {
    const res = await ticketsRoute.POST(post(postBody({ ministry: 'nope' })));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.fields.some((f) => f.field === 'ministry')).toBe(true);
  });

  it('3. POST status=archived → 422 with the exact message', async () => {
    const res = await ticketsRoute.POST(post(postBody({ status: 'archived' })));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    const status = body.fields.find((f) => f.field === 'status');
    expect(status?.message).toBe('archived status cannot be set via API');
  });

  it('malformed JSON → 400', async () => {
    const req = new Request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.authHeader },
      body: '{ not json',
    });
    const res = await ticketsRoute.POST(req);
    expect(res.status).toBe(400);
  });

  it('no API key → 401', async () => {
    const req = new Request('http://localhost/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody()),
    });
    const res = await ticketsRoute.POST(req);
    expect(res.status).toBe(401);
  });
});

describe('AC-VALIDATION — PATCH /tickets/:id through the handler', () => {
  it('4. PATCH status=archived → 422 with the exact "archived status cannot be set via API"', async () => {
    const res = await ticketIdRoute.PATCH(patch(liveId, { status: 'archived' }), {
      params: { id: liveId },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    const status = body.fields.find((f) => f.field === 'status');
    expect(status?.message).toBe('archived status cannot be set via API');
  });

  it('5. PATCH status=snoozed without snoozed_until → 422 with field snoozed_until', async () => {
    const res = await ticketIdRoute.PATCH(patch(liveId, { status: 'snoozed' }), {
      params: { id: liveId },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.fields.some((f) => f.field === 'snoozed_until')).toBe(true);
  });
});
