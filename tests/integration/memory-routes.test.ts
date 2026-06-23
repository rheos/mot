import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 4, Phase 4 (Prompt 6) — the two session-authed Recallatron contract routes that the
// browser UI (Prompts 7 & 8) consumes:
//   GET  /api/memory/entities          → EntityRecord[] (top-level array, AC-17)
//   POST /api/memory/procedural/confirm → ProceduralNote | { error } (AC-19, EC-8)
//
// BOTH routes use the session-OR-key guard (app/api/tickets/[id]/route.ts), NOT the
// API-key-only guard of the neighbour /api/memory route — so a logged-in browser carrying only
// the mot_session cookie (no Bearer key) is accepted. These tests PROVE the real session-cookie
// path (the domain note: a key-only test would pass even if the session path 401'd), AND the
// API-key path, AND the no-auth 401.
//
// Harness mirrors mcp-tools.test.ts: set DATABASE_URL + MOT_GRAPH_PATH BEFORE the first dynamic
// import (the lazy-env ordering the data layer relies on), run migrate_db() for the full schema,
// seed an entity into the graph file, and seed a procedural note row + the auth credentials.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-memory-routes-'));
const tmpDbPath = path.join(tmpDir, 'memory-routes.db');
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.DATABASE_URL = tmpDbPath;
process.env.MOT_GRAPH_PATH = graphFile;

const ROUTE_API_KEY = 'memory-routes-key-0123456789';
process.env.MOT_API_KEY = ROUTE_API_KEY;

const { migrate_db, getDb } = await import('../../db/client');
const { appendEntity } = await import('../../lib/graph');
const { insertCandidate } = await import('../../lib/procedural');
const { bootstrapApiKey, sessionOptions } = await import('../../lib/auth');
const { sealData } = await import('iron-session');

const entitiesRoute = await import('../../app/api/memory/entities/route');
const confirmRoute = await import('../../app/api/memory/procedural/confirm/route');

const SESSION_DIGEST_ID = 's-memory-routes';
let authHeader: { Authorization: string };
let sessionCookie: string;
// Two seeded unconfirmed notes so we can confirm one per credential without cross-contaminating
// (a row, once confirmed, returns { error: 'already_confirmed' } on re-confirm).
let pendingNoteIdForKey: number;
let pendingNoteIdForSession: number;

beforeAll(async () => {
  migrate_db();

  // Seed the API key (hashes ROUTE_API_KEY into app_secret) and seal a session cookie the same
  // way the login route does — this is the real iron-session seal, not a stub (domain note).
  await bootstrapApiKey();
  authHeader = { Authorization: `Bearer ${ROUTE_API_KEY}` };
  const sealed = await sealData(
    { user: 'robin' },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );
  sessionCookie = `${sessionOptions.cookieName}=${sealed}`;

  // Seed an entity carrying "alex" so the q-filter test has a real hit.
  appendEntity({
    type: 'Person',
    label: 'Alex (school)',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
  });

  // procedural_notes.source_session_id is an FK to session_digest(session_id) — seed one.
  getDb()
    .prepare(
      `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
       VALUES (?, 'c1', 'Memory routes session', '2026-06-01T10:00:00.000Z', 1)`,
    )
    .run(SESSION_DIGEST_ID);

  const forKey = insertCandidate('workflow', 'Confirm via API key', SESSION_DIGEST_ID, 'c1');
  const forSession = insertCandidate('workflow', 'Confirm via session cookie', SESSION_DIGEST_ID, 'c1');
  pendingNoteIdForKey = (forKey as { id: number }).id;
  pendingNoteIdForSession = (forSession as { id: number }).id;
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── GET /api/memory/entities (AC-17) ──────────────────────────────────────────
function getEntities(opts: { query?: string; cookie?: string; bearer?: boolean } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = authHeader.Authorization;
  return new Request(`http://localhost/api/memory/entities${opts.query ?? ''}`, { headers });
}

describe('GET /api/memory/entities — session-OR-key read, top-level array (AC-17)', () => {
  it('no auth → 401', async () => {
    const res = await entitiesRoute.GET(getEntities());
    expect(res.status).toBe(401);
  });

  it('valid API key, q empty → 200, body is a top-level array', async () => {
    const res = await entitiesRoute.GET(getEntities({ query: '?q=', bearer: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('valid session cookie (no Bearer key), q empty → 200, array (browser path)', async () => {
    const res = await entitiesRoute.GET(getEntities({ query: '?q=', cookie: sessionCookie }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('q=alex with valid session → 200, array containing the seeded entity', async () => {
    const res = await entitiesRoute.GET(
      getEntities({ query: '?q=alex', cookie: sessionCookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((e) => e.label.toLowerCase().includes('alex'))).toBe(true);
  });
});

// ── POST /api/memory/procedural/confirm (AC-19, EC-8) ─────────────────────────
function postConfirm(opts: { body?: unknown; cookie?: string; bearer?: boolean }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = authHeader.Authorization;
  return new Request('http://localhost/api/memory/procedural/confirm', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

describe('POST /api/memory/procedural/confirm — session-OR-key write (AC-19, EC-8)', () => {
  it('no auth → 401', async () => {
    const res = await confirmRoute.POST(postConfirm({ body: { id: pendingNoteIdForKey } }));
    expect(res.status).toBe(401);
  });

  it('valid API key + valid id → 200, returns the confirmed ProceduralNote', async () => {
    const res = await confirmRoute.POST(
      postConfirm({ body: { id: pendingNoteIdForKey }, bearer: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; confirmed: number };
    expect(body.id).toBe(pendingNoteIdForKey);
    expect(body.confirmed).toBe(1);
  });

  // The domain note: this is the assertion an API-key-only test cannot make — it proves the
  // route accepts the real session cookie (browser path) with NO Bearer key present.
  it('valid session cookie (no Bearer key) + valid id → 200 (browser path)', async () => {
    const res = await confirmRoute.POST(
      postConfirm({ body: { id: pendingNoteIdForSession }, cookie: sessionCookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; confirmed: number };
    expect(body.id).toBe(pendingNoteIdForSession);
    expect(body.confirmed).toBe(1);
  });

  it('typed errors return 200 with the error body, NOT 404/409 (EC-8)', async () => {
    // Re-confirming the already-confirmed key note → { error: 'already_confirmed' } at 200.
    const already = await confirmRoute.POST(
      postConfirm({ body: { id: pendingNoteIdForKey }, bearer: true }),
    );
    expect(already.status).toBe(200);
    expect(await already.json()).toMatchObject({ error: 'already_confirmed' });

    // A missing id → { error: 'not_found' } at 200 (the island reads the body shape).
    const missing = await confirmRoute.POST(
      postConfirm({ body: { id: 999999 }, bearer: true }),
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
  });

  it('missing / non-integer id → 400', async () => {
    const noId = await confirmRoute.POST(postConfirm({ body: {}, bearer: true }));
    expect(noId.status).toBe(400);

    const strId = await confirmRoute.POST(postConfirm({ body: { id: 'x' }, bearer: true }));
    expect(strId.status).toBe(400);
  });
});
