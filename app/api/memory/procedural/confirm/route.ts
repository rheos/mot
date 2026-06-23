import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../../lib/auth';
import { badRequest, internalError } from '../../../../../lib/validation';
import { confirmNote } from '../../../../../lib/procedural';

// ── POST /api/memory/procedural/confirm (Track 4, Phase 4 — Recallatron) ──────
// Session-OR-key WRITE guard, mirroring app/api/tickets/[id]/route.ts:56-58. The Confirm button
// in the ProceduralBrowser island (Prompt 8) POSTs from the browser with only the mot_session
// cookie — an API-key-only guard would 401 it. The write must accept session OR key.
//
// confirmNote returns either the updated ProceduralNote (success) or a typed-error body
// ({ error: 'already_confirmed' | 'not_found' | 'superseded', ... }). ALL of these are returned
// as 200 with the body verbatim — the island reads the body shape (it treats 'already_confirmed'
// as success, EC-8) — so the typed errors are deliberately NOT mapped onto 404/409. Only a
// malformed body (400) or an unexpected exception (500) deviate from 200.
//
// CONTRACT (consumed by Prompt 8 — components/memory/ProceduralBrowser.tsx):
//   POST /api/memory/procedural/confirm
//   Body: { id: number }
//   200: ProceduralNote (success) OR { error: 'already_confirmed' | 'not_found' | 'superseded', ... }
//   400: malformed JSON or missing/non-integer id
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
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { id?: unknown }).id !== 'number'
  ) {
    return badRequest('id (integer) is required');
  }
  const id = (body as { id: number }).id;

  try {
    const result = confirmNote(id);
    // Success (ProceduralNote) and typed-error bodies alike return 200 — the island reads the
    // body shape, not the status (EC-8). Do NOT remap 'not_found'/'superseded' onto 404/409.
    return Response.json(result);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /memory/procedural/confirm error:', e);
    return internalError();
  }
}
