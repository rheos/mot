import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

// AC-STATUS-ENDPOINT — GET /api/status, the one unauthenticated endpoint. A fresh DB reports
// db_ok=true (WAL), last_successful_run=null, all counts zero. Posting tickets moves the
// counts; a past-due snoozed ticket shows up as wake_pending. No auth header is sent — the
// handler must answer anyway.

const auth = await setupRouteDb('status');
const ticketsRoute = await import('../../app/api/tickets/route');
const statusRoute = await import('../../app/api/status/route');

afterAll(() => cleanupTempDb(auth.dbPath));

interface StatusBody {
  db_ok: boolean;
  last_successful_run: string | null;
  ticket_counts: {
    open: number;
    watching: number;
    snoozed: number;
    done: number;
    wake_pending: number;
  };
  ticket_counts_by_ministry: Record<
    string,
    { open: number; watching: number; snoozed: number; done: number }
  >;
}

function post(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.authHeader },
    body: JSON.stringify(bodyObj),
  });
}

async function readStatus(): Promise<{ http: number; body: StatusBody }> {
  // No auth header — /status is public.
  const res = await statusRoute.GET();
  return { http: res.status, body: (await res.json()) as StatusBody };
}

describe('AC-STATUS-ENDPOINT — GET /status', () => {
  it('1. fresh DB → db_ok=true, last_successful_run=null, all counts zero', async () => {
    const { http, body } = await readStatus();
    expect(http).toBe(200);
    expect(body.db_ok).toBe(true);
    expect(body.last_successful_run).toBeNull();
    expect(body.ticket_counts).toEqual({
      open: 0,
      watching: 0,
      snoozed: 0,
      done: 0,
      wake_pending: 0,
    });
    // Every ministry present, zeroed (stable shape on an empty DB).
    expect(body.ticket_counts_by_ministry.works).toEqual({
      open: 0,
      watching: 0,
      snoozed: 0,
      done: 0,
    });
  });

  it('2. one open ticket → ticket_counts.open=1 and that ministry bucket bumps', async () => {
    const created = await ticketsRoute.POST(
      post(postBody({ title: 'Open one', ministry: 'commerce' })),
    );
    expect(created.status).toBe(201);

    const { body } = await readStatus();
    expect(body.ticket_counts.open).toBe(1);
    expect(body.ticket_counts_by_ministry.commerce.open).toBe(1);
  });

  it('3. a past-due snoozed ticket → wake_pending=1', async () => {
    const created = await ticketsRoute.POST(
      post(postBody({ title: 'Snoozed past', ministry: 'flow' })),
    );
    const t = (await created.json()) as { id: string };

    // Drive it directly into a past-due snoozed state (validation rejects a past snoozed_until,
    // but a ticket snoozed earlier becomes past-due as its window elapses — same end state).
    const c = new Database(auth.dbPath);
    try {
      c.prepare(
        "UPDATE ticket SET status = 'snoozed', snoozed_until = ? WHERE id = ?",
      ).run(new Date(Date.now() - 30 * 60_000).toISOString(), t.id);
    } finally {
      c.close();
    }

    const { body } = await readStatus();
    expect(body.ticket_counts.wake_pending).toBe(1);
    expect(body.ticket_counts.snoozed).toBe(1);
  });
});
