import {
  apiKeyGuard,
  unauthorized,
  isSessionRequest,
} from '../../../lib/auth';
import {
  createTicketSchema,
  validationErrorResponse,
  badRequest,
  internalError,
  parsePositiveInt,
} from '../../../lib/validation';
import { createTicket, listTickets, type ListOpts } from '../../../lib/tickets';
import { Ministry, Status, Severity } from '../../../lib/enums';

// ── POST /api/tickets · GET /api/tickets (FR-API-1, FR-API-3) ─────────────────
// Thin handlers: guard → validate → call lib/* → shape the response. No business logic here —
// dedup, the private gate, and the audit write all live in the data layer (P6). POST is
// API-key only; GET accepts an API key OR a session cookie, and the session is what unlocks
// private rows (includePrivate).

// POST /api/tickets — create or dedup-absorb a ticket (FR-API-1).
//   201 created · 200 updated|reopened|grouped · 422 validation · 401 auth · 400 malformed JSON.
// Auth: API key (API consumers) OR session cookie (the UI) — both share this endpoint per the
// spec ("API key for API consumers; session cookie for the UI"). The manual create form POSTs
// from the browser with only the session cookie, so a key-only guard would 401 every UI create.
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

  const parsed = createTicketSchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = createTicket(parsed.data);
    const status = result.action === 'created' ? 201 : 200;
    return Response.json(
      { id: result.id, action: result.action, ticket: result.ticket },
      { status },
    );
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /tickets error:', e);
    return internalError();
  }
}

// GET /api/tickets — the triage list (FR-API-3). API key OR session; only a session unlocks
// private rows. Filters (status/ministry/severity multi, needs_review, wake_pending, q) and
// pagination are parsed from the query string, then handed to listTickets, which applies the
// private gate IN the SQL.
export async function GET(req: Request): Promise<Response> {
  const hasKey = await apiKeyGuard(req);
  const hasSession = await isSessionRequest(req);
  if (!hasKey && !hasSession) return unauthorized();

  const url = new URL(req.url);
  const opts = parseListOpts(url.searchParams, hasSession);

  try {
    const result = listTickets(opts);
    return Response.json(result);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /tickets error:', e);
    return internalError();
  }
}

// Project the raw query string onto ListOpts. Unknown filter values are dropped (only enum
// members survive), so a junk `?status=nonsense` quietly yields no status filter rather than a
// SQL error. includePrivate is derived solely from session presence (the private gate).
function parseListOpts(
  params: URLSearchParams,
  includePrivate: boolean,
): ListOpts {
  const opts: ListOpts = { includePrivate };

  // `archived` is a cron-only terminal status (retention sweep), not a triage filter — drop it
  // from the queryable set so a `?status=archived` can't surface retired tickets through the API.
  const status = filterEnum(params.getAll('status'), Status).filter((s) => s !== Status.archived);
  if (status.length > 0) opts.status = status;

  const ministry = filterEnum(params.getAll('ministry'), Ministry);
  if (ministry.length > 0) opts.ministry = ministry;

  const severity = filterEnum(params.getAll('severity'), Severity);
  if (severity.length > 0) opts.severity = severity;

  const needsReview = parseBool(params.get('needs_review'));
  if (needsReview !== undefined) opts.needs_review = needsReview;

  if (parseBool(params.get('wake_pending')) === true) opts.wake_pending = true;

  const q = params.get('q');
  if (q && q.trim()) opts.q = q;

  const page = parsePositiveInt(params.get('page'));
  if (page !== undefined) opts.page = page;

  const perPage = parsePositiveInt(params.get('per_page'));
  if (perPage !== undefined) opts.per_page = perPage;

  return opts;
}

// Keep only the query values that are real members of the given const-enum map.
function filterEnum<T extends string>(
  values: string[],
  enumMap: Record<string, T>,
): T[] {
  const allowed = new Set<string>(Object.values(enumMap));
  return values.filter((v): v is T => allowed.has(v));
}

// `?flag=true` / `?flag=1` → true; `false` / `0` → false; absent or anything else → undefined.
function parseBool(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

