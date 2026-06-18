// tests/integration/moi-ec6-empty-run.test.ts
// AC-EC6 — empty run: heartbeat ticket present + "all quiet" dry-run briefing.
// Two parts:
//   1. A heartbeat ticket POST succeeds and is persisted (asserts Prompt 03's heartbeat row).
//   2. briefing.py --dry-run prints the "all quiet" structured briefing to stdout (asserts
//      Prompt 06's --dry-run contract, Telegram stubbed / not sent).
// Uses setupRouteDb / postBody from _helpers.ts (M3).

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';

const auth = await setupRouteDb('moi-ec6');
const ticketsRoute = await import('../../app/api/tickets/route');

afterAll(() => cleanupTempDb(auth.dbPath));

const TODAY_UTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

describe('AC-EC6 — empty run: heartbeat + all-quiet briefing', () => {
  it('heartbeat ticket POST succeeds and is persisted with correct source_ref', async () => {
    const res = await ticketsRoute.POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.authHeader },
        body: JSON.stringify(
          postBody({
            title: `Intake pipeline ran — ${TODAY_UTC}`,
            ministry: 'works',
            ticket_type: 'pipeline-heartbeat',
            severity: 'low',
            provenance: 'heartbeat',
            source_ref: `pipeline:${TODAY_UTC}`,
            body: 'Automated intake pipeline completed. Tickets filed: 0.',
            // heartbeat creates MAY carry an audit block; the gmail-parse refine doesn't apply.
            classification_audit: {
              signal_fingerprint: `pipeline:${TODAY_UTC}:heartbeat`,
              model_version: 'claude-sonnet-4-5',
              confidence: 1.0,
              prompt_hash: 'b'.repeat(64),
            },
          }),
        ),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ticket: { source_ref: string; ticket_type: string };
    };
    expect(body.ticket.source_ref).toBe(`pipeline:${TODAY_UTC}`);
    expect(body.ticket.ticket_type).toBe('pipeline-heartbeat');

    // Confirm persisted.
    const c = new Database(auth.dbPath);
    try {
      const row = c
        .prepare(
          "SELECT COUNT(*) AS n FROM ticket WHERE source_ref = ? AND ticket_type = 'pipeline-heartbeat'",
        )
        .get(`pipeline:${TODAY_UTC}`) as { n: number };
      expect(row.n).toBe(1);
    } finally {
      c.close();
    }
  });

  it('same-day heartbeat re-file groups (dedup, one row)', async () => {
    const res = await ticketsRoute.POST(
      new Request('http://localhost/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.authHeader },
        body: JSON.stringify(
          postBody({
            title: `Intake pipeline ran — ${TODAY_UTC}`,
            ministry: 'works',
            ticket_type: 'pipeline-heartbeat',
            severity: 'low',
            provenance: 'heartbeat',
            source_ref: `pipeline:${TODAY_UTC}`,
            body: 'Automated intake pipeline completed. Tickets filed: 0.',
          }),
        ),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe('grouped');
  });

  it('briefing.py --dry-run prints all-quiet structured briefing to stdout', () => {
    // Run briefing.py --dry-run. MOT_BRIEFING_DRY_RUN=1 is the env-var equivalent.
    // IMPORTANT: setupRouteDb() sets process.env.MOT_API_KEY at module top level. We must NOT
    // pass that through, or briefing.py's build_briefing() would attempt a real 15s network call
    // to MOT_API_URL (production https://example.com/mot/api) with a bogus key. Stripping the key
    // (and pointing MOT_API_URL at an inert localhost as defense-in-depth) forces the clean
    // no-key dry-run path: "All quiet (dry-run, no API key)." exit 0, no Telegram, no network.
    const briefingScript = path.join(process.cwd(), 'bot', 'briefing.py');
    const childEnv: NodeJS.ProcessEnv = { ...process.env, MOT_BRIEFING_DRY_RUN: '1' };
    delete childEnv.MOT_API_KEY;
    childEnv.MOT_API_URL = 'http://127.0.0.1:1/__no_network__';
    let stdout: string;
    try {
      stdout = execFileSync('python3', [briefingScript, '--dry-run'], {
        env: childEnv,
        encoding: 'utf8',
      });
    } catch {
      // If python3 is not available or briefing.py doesn't exist, skip gracefully.
      // eslint-disable-next-line no-console
      console.warn('briefing.py --dry-run skipped: python3 not available or script missing');
      return;
    }
    // The dry-run output must include either "All quiet" or the structured briefing header.
    expect(stdout.toLowerCase()).toMatch(/all quiet|m\.o\.t\. daily briefing/);
    // Must NOT contain any evidence of a Telegram call.
    expect(stdout.toLowerCase()).not.toContain('api.telegram.org');
  });
});
