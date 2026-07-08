import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../lib/auth';
import { badRequest, internalError } from '../../../../lib/validation';
import { confirmRelate, rejectRelate } from '../../../../lib/graph';

// ── POST /api/memory/relations (Track 6, Phase 4 — Recallatron entity edges) ──────
// Session-OR-key WRITE guard, mirroring app/api/memory/procedural/confirm/route.ts. The
// Confirm/Reject buttons in the EntityDetail island (Prompt 4) POST from the browser with only
// the mot_session cookie — /api/mcp is API-key-only and would 401 that cookie, so this route
// exists to give the browser a session-authed way to confirm/reject a candidate edge.
//
// confirmRelate / rejectRelate return either the resolved RelatePatch (success) or a typed-error
// body ({ error: 'not_found' | 'already_confirmed' | 'already_rejected' }). ALL of these are
// returned as 200 with the body verbatim — the island reads the body SHAPE, not the status (it
// treats 'already_confirmed' / 'already_rejected' as UI success) — so the typed errors are
// deliberately NOT mapped onto 404/409. Only a malformed/missing body (400) or an unexpected
// exception (500) deviate from 200.
//
// CONTRACT (consumed by components/memory/EntityBrowser.tsx — the EntityDetail island):
//   POST /api/memory/relations
//   Body: { from: string, rel: string, to: string, action: 'confirm' | 'reject' }
//   200: RelatePatch (success) OR { error: 'not_found' | 'already_confirmed' | 'already_rejected' }
//   400: malformed JSON or missing/empty required fields
//   401: session OR API key required
export async function POST(req: Request): Promise<Response> {
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Malformed JSON');
  }
  if (typeof body !== 'object' || body === null) {
    return badRequest('from, rel, to (non-empty strings) and action are required');
  }
  const { from, rel, to, action } = body as {
    from?: unknown;
    rel?: unknown;
    to?: unknown;
    action?: unknown;
  };
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!nonEmpty(from) || !nonEmpty(rel) || !nonEmpty(to)) {
    return badRequest('from, rel and to must be non-empty strings');
  }
  if (action !== 'confirm' && action !== 'reject') {
    return badRequest("action must be 'confirm' or 'reject'");
  }

  try {
    // confirmRelate/rejectRelate never throw (AC-12) — a RelatePatch on success, a typed { error }
    // on a pre-checked failure. Both go back verbatim at 200; the island branches on the shape.
    const result = action === 'confirm' ? confirmRelate(from, rel, to) : rejectRelate(from, rel, to);
    return Response.json(result);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /memory/relations error:', e);
    return internalError();
  }
}
