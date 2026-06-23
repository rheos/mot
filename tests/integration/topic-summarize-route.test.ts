import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 4, Phase 5 (Prompt 9) — GET /api/memory/topics/[slug]/summarize.
//   AC-19 (topics half): the session-OR-key guard — no auth → 401, valid session → 200, valid
//   API key → 200. The route is consumed by the browser Synthesize button (Prompt 10), which
//   carries ONLY the mot_session cookie (no Bearer key); a key-only test would pass even if the
//   session path 401'd, so we PROVE the real session-cookie path with a real iron-session seal.
//
// Harness mirrors memory-routes.test.ts: set DATABASE_URL BEFORE the first dynamic import, run
// migrate_db() for the full schema, seed the API key + a sealed session cookie, and seed one real
// thread so the valid-auth requests resolve a thread (the not-found body would still 200, but a
// real thread proves the success arm).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-topic-summarize-route-'));
const tmpDbPath = path.join(tmpDir, 'topic-summarize-route.db');
process.env.DATABASE_URL = tmpDbPath;

const ROUTE_API_KEY = 'topic-summarize-key-0123456789';
process.env.MOT_API_KEY = ROUTE_API_KEY;

const { migrate_db, getDb } = await import('../../db/client');
const { createThread, linkThreadSession } = await import('../../lib/topics');
const { bootstrapApiKey, sessionOptions } = await import('../../lib/auth');
const { sealData } = await import('iron-session');

const summarizeRoute = await import(
  '../../app/api/memory/topics/[slug]/summarize/route'
);

const THREAD_SLUG = 'route-thread';
let authHeader: { Authorization: string };
let sessionCookie: string;

beforeAll(async () => {
  migrate_db();

  await bootstrapApiKey();
  authHeader = { Authorization: `Bearer ${ROUTE_API_KEY}` };
  const sealed = await sealData(
    { user: 'robin' },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );
  sessionCookie = `${sessionOptions.cookieName}=${sealed}`;

  // Seed a real thread with one linked session so the success arm is exercised end-to-end.
  createThread(THREAD_SLUG, 'Route thread');
  getDb()
    .prepare(
      `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
       VALUES ('s-route-1', 'c1', 'Route session summary', '2026-06-01T00:00:00.000Z', 1)`,
    )
    .run();
  linkThreadSession(THREAD_SLUG, 's-route-1');
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getSummarize(opts: { slug?: string; cookie?: string; bearer?: boolean } = {}): {
  req: Request;
  ctx: { params: { slug: string } };
} {
  const slug = opts.slug ?? THREAD_SLUG;
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = authHeader.Authorization;
  return {
    req: new Request(`http://localhost/api/memory/topics/${slug}/summarize`, { headers }),
    ctx: { params: { slug } },
  };
}

describe('GET /api/memory/topics/[slug]/summarize — session-OR-key read (AC-19, topics half)', () => {
  it('no auth → 401', async () => {
    const { req, ctx } = getSummarize();
    const res = await summarizeRoute.GET(req, ctx);
    expect(res.status).toBe(401);
  });

  it('valid session cookie (no Bearer key) → 200 (browser path)', async () => {
    const { req, ctx } = getSummarize({ cookie: sessionCookie });
    const res = await summarizeRoute.GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; session_count: number };
    expect(body.slug).toBe(THREAD_SLUG);
    expect(body.session_count).toBe(1);
  });

  it('valid API key → 200', async () => {
    const { req, ctx } = getSummarize({ bearer: true });
    const res = await summarizeRoute.GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe(THREAD_SLUG);
  });

  it('unknown slug with valid auth → 200 with the thread_not_found body (AC-4 over HTTP)', async () => {
    const { req, ctx } = getSummarize({ slug: 'does-not-exist', bearer: true });
    const res = await summarizeRoute.GET(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: 'thread_not_found', slug: 'does-not-exist' });
  });
});
