import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../../../lib/auth';
import { internalError } from '../../../../../../lib/validation';
import { summarizeThread } from '../../../../../../lib/topics';

// ── GET /api/memory/topics/[slug]/summarize (Track 4, Phase 5 — topics Synthesize) ──
// Session-OR-key READ guard, mirroring app/api/tickets/[id]/route.ts — the browser's Synthesize
// button carries only the mot_session cookie (no Bearer key), so the API-key-only /api/mcp
// endpoint (app/api/mcp/route.ts) would 401 it; this route accepts EITHER credential.
//
// mot stays MODEL-FREE (OQ-1 = (b)): summarizeThread returns the STRUCTURED most-recent sessions
// (SummarizeResult), not synthesized prose — Rheo synthesizes from the array.
//
// An unknown slug returns a 200 with the { error: 'thread_not_found', slug } body (NOT a 404):
// AC-4 is satisfied at the helper layer, and the island reads the body shape to tell not-found
// from a network error.
//
// CONTRACT (consumed by Prompt 10 — components/memory/TopicBrowser.tsx):
//   GET /api/memory/topics/<slug>/summarize
//   200: SummarizeResult
//     Success:   { slug, title, session_count, truncated, truncation_note?, sessions: [{session_id, summary, ts}] }
//     Not found: { error: 'thread_not_found', slug }
//   401: unauthorized (session OR API key required)
interface RouteContext {
  // Next.js 14 (package.json: next ^14.2.35) — params is a plain object, NOT a Promise.
  params: Promise<{ slug: string }>;
}

export async function GET(req: Request, props: RouteContext): Promise<Response> {
  const params = await props.params;
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  try {
    const { slug } = params;
    const result = summarizeThread(slug);
    // 200 even for { error: 'thread_not_found' } — the island branches on the body shape.
    return Response.json(result);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /memory/topics/[slug]/summarize error:', e);
    return internalError();
  }
}
