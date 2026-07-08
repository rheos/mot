import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 6, Phase 4 (Prompt 4) — the session-authed contract route the EntityDetail island consumes:
//   POST /api/memory/relations → RelatePatch | { error } (AC-12)
//
// This route is a THIN wrapper over confirmRelate / rejectRelate (both tested at depth in Prompt 1's
// graph suite). So these tests own only the routing/validation layer: the session-OR-key guard (401),
// body validation (400), and that a clean call dispatches to confirmRelate/rejectRelate. The
// confirm/reject fold semantics are NOT re-tested here.
//
// Harness mirrors memory-routes.test.ts: set DATABASE_URL + MOT_GRAPH_PATH BEFORE the first dynamic
// import (the lazy-env ordering the data layer relies on), run migrate_db() for the schema + the
// app_secret row, seed the API key, and seal a real session cookie.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-relations-route-'));
const tmpDbPath = path.join(tmpDir, 'relations-route.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const ROUTE_API_KEY = 'relations-route-key-0123456789';
process.env.MOT_API_KEY = ROUTE_API_KEY;

const { migrate_db, getDb } = await import('../../db/client');
const { appendEntity, appendRelate } = await import('../../lib/graph');
const { bootstrapApiKey, sessionOptions } = await import('../../lib/auth');
const { sealData } = await import('iron-session');

const relationsRoute = await import('../../app/api/memory/relations/route');

let authHeader: { Authorization: string };
let sessionCookie: string;
// A seeded unconfirmed candidate edge (from → to) so the happy-path confirm has something to act on.
let fromId: string;
let toId: string;

beforeAll(async () => {
  migrate_db();
  await bootstrapApiKey();
  authHeader = { Authorization: `Bearer ${ROUTE_API_KEY}` };
  const sealed = await sealData(
    { user: 'robin' },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );
  sessionCookie = `${sessionOptions.cookieName}=${sealed}`;

  const from = appendEntity({
    type: 'Person',
    label: 'From node',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
  });
  const to = appendEntity({
    type: 'Fact',
    label: 'To node',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
  });
  fromId = from.id;
  toId = to.id;
  // An unconfirmed candidate edge — confirmRelate will flip it to confirmed on the happy path.
  appendRelate(fromId, 'child_of', toId, 0.9, 'session:seed', false);
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(opts: { body?: unknown; raw?: string; cookie?: string; bearer?: boolean }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = authHeader.Authorization;
  return new Request('http://localhost/api/memory/relations', {
    method: 'POST',
    headers,
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(opts.body),
  });
}

describe('POST /api/memory/relations — routing + validation (Track 6 Phase 4)', () => {
  it('no session cookie and no API key → 401', async () => {
    const res = await relationsRoute.POST(
      post({ body: { from: 'a', rel: 'child_of', to: 'b', action: 'confirm' } }),
    );
    expect(res.status).toBe(401);
  });

  it('malformed JSON → 400', async () => {
    const res = await relationsRoute.POST(post({ raw: 'not json', bearer: true }));
    expect(res.status).toBe(400);
  });

  it("action missing → 400", async () => {
    const res = await relationsRoute.POST(post({ body: { from: 'a', rel: 'child_of', to: 'b' }, bearer: true }));
    expect(res.status).toBe(400);
  });

  it("action not 'confirm' | 'reject' → 400", async () => {
    const res = await relationsRoute.POST(
      post({ body: { from: 'a', rel: 'child_of', to: 'b', action: 'delete' }, bearer: true }),
    );
    expect(res.status).toBe(400);
  });

  it.each(['from', 'rel', 'to'])('%s absent → 400', async (field) => {
    const full: Record<string, string> = { from: 'a', rel: 'child_of', to: 'b', action: 'confirm' };
    delete full[field];
    const res = await relationsRoute.POST(post({ body: full, bearer: true }));
    expect(res.status).toBe(400);
  });

  it.each(['from', 'rel', 'to'])('%s empty string → 400', async (field) => {
    const full: Record<string, string> = { from: 'a', rel: 'child_of', to: 'b', action: 'confirm' };
    full[field] = '   ';
    const res = await relationsRoute.POST(post({ body: full, bearer: true }));
    expect(res.status).toBe(400);
  });

  it('valid API key + valid body → 200, dispatches to confirmRelate (RelatePatch back)', async () => {
    const res = await relationsRoute.POST(
      post({ body: { from: fromId, rel: 'child_of', to: toId, action: 'confirm' }, bearer: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { op?: string; confirmed?: boolean };
    expect(body.op).toBe('relate');
    expect(body.confirmed).toBe(true);
  });

  // The domain note (mirrors memory-routes.test.ts): the assertion a key-only test cannot make —
  // the route accepts a real session cookie (browser path) with NO Bearer key present. A typed
  // { error } body still returns 200 (the island reads the shape, AC-12).
  it('valid session cookie (no Bearer key) → 200, typed error body at 200 not 4xx', async () => {
    const res = await relationsRoute.POST(
      post({ body: { from: 'nonexistent', rel: 'child_of', to: 'alsonope', action: 'confirm' }, cookie: sessionCookie }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});
