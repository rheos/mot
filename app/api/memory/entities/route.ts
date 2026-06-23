import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../lib/auth';
import { internalError } from '../../../../lib/validation';
import { searchEntities, type EntityRecord } from '../../../../lib/graph';

// ── GET /api/memory/entities (Track 4, Phase 4 — Recallatron entity browser) ──
// Session-OR-key READ guard, mirroring app/api/tickets/route.ts:60-63. The browser carries
// only the mot_session cookie (no Bearer key), so the API-key-only guard on the neighbouring
// /api/memory route would 401 every logged-in UI request — this route must accept EITHER
// credential. The response is a TOP-LEVEL JSON array (EntityRecord[]), not an envelope object:
// the EntityBrowser island (Prompt 7) reads the array directly and AC-17 asserts it.
//
// CONTRACT (consumed by Prompt 7 — components/memory/EntityBrowser.tsx):
//   GET /api/memory/entities?q=<string>&type=<string?>&unconfirmed_only=<bool?>
//   200: EntityRecord[]   (top-level array — NOT { entities: [...] })
//   401: unauthorized (session OR API key required)
//   q: empty string matches all active entities; non-empty is a keyword filter.
export async function GET(req: Request): Promise<Response> {
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';
    // type is an optional EntityRecord['type'] filter. searchEntities only narrows when the
    // value is a real member, so a junk ?type=foo yields no entity rows — acceptable for a
    // typed-cast read filter (the UI only ever sends valid types).
    const type =
      (url.searchParams.get('type') as EntityRecord['type'] | null) ?? undefined;
    const unconfirmedOnly = url.searchParams.get('unconfirmed_only') === 'true';

    const results = searchEntities(q, type || undefined, unconfirmedOnly || undefined);
    return Response.json(results);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /memory/entities error:', e);
    return internalError();
  }
}
