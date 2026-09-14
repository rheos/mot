import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../../lib/auth';
import {
  patchTicketSchema,
  validationErrorResponse,
  badRequest,
  notFound,
  internalError,
} from '../../../../lib/validation';
import { getTicket, patchTicket, TicketError } from '../../../../lib/tickets';

// ── GET /api/tickets/:id · PATCH /api/tickets/:id (FR-API-4, FR-API-2) ────────
// GET: API key OR session; a private ticket without a session returns 404 — NOT 403 — so the
// endpoint never confirms a private ticket's existence to an unprivileged caller (AC-PRIVATE).
// PATCH: API-key only. Validation runs through patchTicketSchema (which owns the exact
// 'archived status cannot be set via API' message); the data layer throws TicketError for an
// illegal transition or a 404, and we map TicketError.status straight onto the response.

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/tickets/:id — one ticket plus its comment history (FR-API-4).
export async function GET(req: Request, props: RouteContext): Promise<Response> {
  const params = await props.params;
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  try {
    // includePrivate = session presence. getTicket returns null for a private ticket without a
    // session → 404 (AC-PRIVATE: do not distinguish "private, hidden" from "does not exist").
    const ticket = getTicket(params.id, hasSession);
    if (!ticket) return notFound();
    return Response.json({ ticket });
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /tickets/:id error:', e);
    return internalError();
  }
}

// PATCH /api/tickets/:id — mutate one ticket (FR-API-2). Auth: API key (API consumers) OR
// session cookie (the UI) — both share this endpoint per the spec. The triage actions, comment
// box, ministry re-assign, and wake-all all PATCH from the browser with only the session cookie,
// so a key-only guard would 401 every UI mutation.
export async function PATCH(req: Request, props: RouteContext): Promise<Response> {
  const params = await props.params;
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Malformed JSON');
  }

  const parsed = patchTicketSchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const ticket = patchTicket(params.id, parsed.data);
    return Response.json({ id: ticket.id, ticket });
  } catch (e: unknown) {
    // The data layer signals illegal-transition (422) and not-found (404) via TicketError;
    // carry its status + message onto the HTTP response verbatim.
    if (e instanceof TicketError) {
      return Response.json(
        { error: 'invalid_transition', message: e.message },
        { status: e.status },
      );
    }
    // eslint-disable-next-line no-console
    console.error('[MOT] PATCH /tickets/:id error:', e);
    return internalError();
  }
}
