import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../../lib/auth';
import { badRequest, internalError } from '../../../../../lib/validation';
import { confirmEntity } from '../../../../../lib/graph';

// ── POST /api/memory/entities/confirm (Recallatron entity confirm) ────────────────
// Session-OR-key WRITE guard, mirroring app/api/memory/relations/route.ts. The Confirm
// button on an unconfirmed entity in the EntityDetail panel POSTs from the browser with only
// the mot_session cookie — /api/mcp is API-key-only and would 401 that cookie, so this route
// gives the browser a session-authed way to confirm a candidate entity (the same action the
// entity_confirm MCP tool performs for Rheo).
//
// confirmEntity returns the updated EntityRecord (success) or a typed-error body
// ({ error: 'not_found' | 'already_confirmed' }). BOTH are returned as 200 with the body
// verbatim — the island reads the body SHAPE, not the status (it treats 'already_confirmed'
// as UI success) — so typed errors are deliberately NOT mapped onto 404/409. Only a
// malformed/missing body (400) or an unexpected exception (500) deviate from 200.
//
// CONTRACT (consumed by components/memory/EntityBrowser.tsx — the EntityDetail island):
//   POST /api/memory/entities/confirm
//   Body: { id: string }
//   200: EntityRecord (success) OR { error: 'not_found' | 'already_confirmed' }
//   400: malformed JSON or missing/empty id
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
    return badRequest('id (a non-empty string) is required');
  }
  const { id } = body as { id?: unknown };
  if (typeof id !== 'string' || id.trim() === '') {
    return badRequest('id must be a non-empty string');
  }

  try {
    // confirmEntity never throws — an EntityRecord on success, a typed { error } on a
    // pre-checked failure. Both go back verbatim at 200; the island branches on the shape.
    return Response.json(confirmEntity(id));
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /memory/entities/confirm error:', e);
    return internalError();
  }
}
