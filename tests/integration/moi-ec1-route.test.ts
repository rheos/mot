// tests/integration/moi-ec1-route.test.ts
// AC-EC1 (Phase 2 reframe) — route-level idempotent grouping for gmail-parse + audit block.
// Drives the POST /api/tickets route handler with real Zod validation + audit enforcement.
// The data-layer analog is dedup.ec1.test.ts (Scenario A) — that test covers createTicket()
// directly; this test covers the route + Zod refine + audit path (M2).
// Uses setupRouteDb / postBody from _helpers.ts (M3).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

const auth = await setupRouteDb('moi-ec1-route');
const ticketsRoute = await import('../../app/api/tickets/route');

afterAll(() => cleanupTempDb(auth.dbPath));

// classificationAuditSchema (lib/validation.ts) requires signal_fingerprint, model_version,
// confidence; prompt_hash is optional there but REQUIRED non-empty for gmail-parse by the refine.
const AUDIT_BLOCK = {
  signal_fingerprint: 'abc123:gmail-msg-abc:deadbeef',
  model_version: 'claude-sonnet-4-5',
  confidence: 0.92,
  prompt_hash: 'a'.repeat(64), // 64-char hex string (SHA-256 placeholder)
};

function gmailPost(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(
      postBody({
        provenance: 'gmail-parse',
        source_ref: 'test-msg-abc123',
        ticket_type: 'bill-due',
        ministry: 'plenty',
        severity: 'normal',
        classification_audit: AUDIT_BLOCK,
        ...overrides,
      }),
    ),
  });
}

// dedup_key = `${source_ref}:${ticket_type}` (lib/dedup.computeDedupKey).
function rowCount(dedupKey: string): number {
  const c = new Database(auth.dbPath);
  try {
    return (
      c.prepare('SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = ?').get(dedupKey) as {
        n: number;
      }
    ).n;
  } finally {
    c.close();
  }
}

describe('AC-EC1 Phase 2 — route-level gmail-parse dedup + audit enforcement', () => {
  it('first gmail-parse create with audit block → 201 created', async () => {
    const res = await ticketsRoute.POST(gmailPost());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe('created');
    expect(rowCount('test-msg-abc123:bill-due')).toBe(1);
  });

  it('same source_ref second time → 200 grouped (one row)', async () => {
    const res = await ticketsRoute.POST(gmailPost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; ticket: { event_count: number } };
    expect(body.action).toBe('grouped');
    expect(body.ticket.event_count).toBe(2);
    expect(rowCount('test-msg-abc123:bill-due')).toBe(1); // still one row
  });

  it('gmail-parse WITHOUT classification_audit → 422', async () => {
    const res = await ticketsRoute.POST(gmailPost({ classification_audit: undefined }));
    expect(res.status).toBe(422);
  });

  it('gmail-parse WITH audit block but prompt_hash absent → 422', async () => {
    const res = await ticketsRoute.POST(
      gmailPost({ classification_audit: { ...AUDIT_BLOCK, prompt_hash: null } }),
    );
    expect(res.status).toBe(422);
  });

  it('manual create WITHOUT classification_audit → 201 (refine must not block manual)', async () => {
    const res = await ticketsRoute.POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.authHeader },
        body: JSON.stringify(
          postBody({
            provenance: 'manual',
            source_ref: 'manual-test-1',
            ticket_type: 'infra-alert',
            // No classification_audit.
          }),
        ),
      }),
    );
    expect(res.status).toBe(201);
  });
});
