import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The session-authed contract route the EntityDetail Confirm button consumes:
//   POST /api/memory/entities/confirm → EntityRecord | { error } (200 verbatim)
//
// This route is a THIN wrapper over confirmEntity (also used by the entity_confirm MCP tool). These
// tests own the routing/validation layer (401 / 400 / dispatch) plus the confirmEntity contract
// (confirm flips confirmed→true; already_confirmed and not_found/superseded are typed errors at 200).
//
// Harness mirrors relations-route.test.ts: set DATABASE_URL + MOT_GRAPH_PATH before the first
// dynamic import, run migrate_db(), seed the API key, seal a real session cookie.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-entities-confirm-'));
const tmpDbPath = path.join(tmpDir, 'entities-confirm.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const ROUTE_API_KEY = 'entities-confirm-key-0123456789';
process.env.MOT_API_KEY = ROUTE_API_KEY;

const { migrate_db, getDb } = await import('../../db/client');
const { appendEntity, appendSupersede, confirmEntity, getEntity } = await import('../../lib/graph');
const { bootstrapApiKey, sessionOptions } = await import('../../lib/auth');
const { sealData } = await import('iron-session');

const confirmRoute = await import('../../app/api/memory/entities/confirm/route');

let authHeader: { Authorization: string };
let sessionCookie: string;
let unconfirmedId: string; // confirmed:false — the happy-path target
let confirmedId: string; // confirmed:true — already_confirmed
let supersededId: string; // superseded → not_found (not confirmable in place)

function seed(label: string, confirmed: boolean): string {
  return appendEntity({
    type: 'Fact',
    label,
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.7,
    source: 'session:seed',
    superseded_by: null,
    confirmed,
  }).id;
}

beforeAll(async () => {
  migrate_db();
  await bootstrapApiKey();
  authHeader = { Authorization: `Bearer ${ROUTE_API_KEY}` };
  const sealed = await sealData(
    { user: 'robin' },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );
  sessionCookie = `${sessionOptions.cookieName}=${sealed}`;

  unconfirmedId = seed('Unconfirmed candidate', false);
  confirmedId = seed('Already confirmed', true);
  supersededId = seed('Superseded node', false);
  appendSupersede(supersededId, 'pruned');
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(opts: { body?: unknown; raw?: string; cookie?: string; bearer?: boolean }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = authHeader.Authorization;
  return new Request('http://localhost/api/memory/entities/confirm', {
    method: 'POST',
    headers,
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(opts.body),
  });
}

describe('confirmEntity (lib/graph) — shared pre-checks', () => {
  it('not_found for a missing id', () => {
    expect(confirmEntity('does-not-exist')).toMatchObject({ error: 'not_found' });
  });

  it('not_found for a superseded/pruned entity (not confirmable in place)', () => {
    expect(confirmEntity(supersededId)).toMatchObject({ error: 'not_found' });
  });

  it('already_confirmed for an already-confirmed entity', () => {
    expect(confirmEntity(confirmedId)).toMatchObject({ error: 'already_confirmed' });
  });
});

describe('POST /api/memory/entities/confirm — routing + validation', () => {
  it('no session cookie and no API key → 401', async () => {
    const res = await confirmRoute.POST(post({ body: { id: unconfirmedId } }));
    expect(res.status).toBe(401);
  });

  it('malformed JSON → 400', async () => {
    const res = await confirmRoute.POST(post({ raw: 'not json', bearer: true }));
    expect(res.status).toBe(400);
  });

  it('id absent → 400', async () => {
    const res = await confirmRoute.POST(post({ body: {}, bearer: true }));
    expect(res.status).toBe(400);
  });

  it('id empty string → 400', async () => {
    const res = await confirmRoute.POST(post({ body: { id: '   ' }, bearer: true }));
    expect(res.status).toBe(400);
  });

  it('valid session cookie (no Bearer) + unconfirmed id → 200, entity flipped to confirmed', async () => {
    expect(getEntity(unconfirmedId)?.record.confirmed).toBe(false);
    const res = await confirmRoute.POST(post({ body: { id: unconfirmedId }, cookie: sessionCookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed?: boolean; id?: string };
    expect(body.confirmed).toBe(true);
    expect(getEntity(unconfirmedId)?.record.confirmed).toBe(true);
  });

  it('valid key + nonexistent id → 200 with typed { error: not_found } (not 4xx)', async () => {
    const res = await confirmRoute.POST(post({ body: { id: 'nonexistent' }, bearer: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});
