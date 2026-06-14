import { listTickets, type Ticket, type ListOpts } from '../lib/tickets';
import { Ministry, Status, Severity } from '../lib/enums';
import { TriageList } from '../components/TriageList';
import type { TriageTicketView } from '../components/TriageRow';

// Triage view (FR-UI-1/2/5). Server Component: it reads the URL search params and queries the
// data layer IN-PROCESS (no fetch — this is what Server Components are for). The page is only
// reachable behind a valid session (middleware, Prompt 4), so includePrivate is true: the
// operator sees private tickets. Default with no status param is open-only; the data layer sorts
// severity desc then updated_at desc. The result is handed to the client TriageList as
// initialData, which owns interactivity, the four UI states, and the retry path.
//
// Next 14 passes searchParams as a plain (sync) prop. Repeated params (?status=a&status=b)
// arrive as string[]; a single value as string. We normalize to arrays and keep only real enum
// members (mirrors the route handler's filterEnum), so junk params degrade to "no filter".

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default function TriagePage({
  searchParams,
}: {
  searchParams: SearchParams;
}): React.JSX.Element {
  const opts = buildListOpts(searchParams);
  const query = buildQueryString(searchParams);
  const q = single(searchParams.q)?.trim() || undefined;
  const needsReview = single(searchParams.needs_review) === 'true';

  let tickets: TriageTicketView[] = [];
  let wakePending: TriageTicketView[] = [];
  let error = false;

  try {
    tickets = listTickets(opts).tickets.map(toView);
    wakePending = listTickets({ wake_pending: true, includePrivate: true }).tickets.map(
      toView,
    );
  } catch {
    error = true;
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-4">
      <TriageList initial={{ tickets, wakePending, error, query, q, needsReview }} />
    </main>
  );
}

// Map a full stored Ticket down to the narrow, serializable slice the client rows need.
function toView(t: Ticket): TriageTicketView {
  return {
    id: t.id,
    title: t.title,
    ministry: t.ministry,
    severity: t.severity,
    ticket_type: t.ticket_type,
    needs_review: t.needs_review,
    event_count: t.event_count,
    updated_at: t.updated_at,
  };
}

function buildListOpts(params: SearchParams): ListOpts {
  // includePrivate is true here: the page only renders behind a session (middleware), and a
  // session is exactly what unlocks private rows (FR-API-3).
  const opts: ListOpts = { includePrivate: true };

  const status = filterEnum(asArray(params.status), Status);
  if (status.length > 0) opts.status = status;

  const ministry = filterEnum(asArray(params.ministry), Ministry);
  if (ministry.length > 0) opts.ministry = ministry;

  const severity = filterEnum(asArray(params.severity), Severity);
  if (severity.length > 0) opts.severity = severity;

  // Needs-review preset (FR-UI-6): a queue across ALL lifecycle statuses, not just open. The
  // data layer defaults to status='open' whenever no status filter is set, so we pass the full
  // lifecycle set explicitly here — that keeps the queue spanning open/watching/snoozed/done
  // while staying inside the built listTickets contract (no backend change).
  if (single(params.needs_review) === 'true') {
    opts.needs_review = true;
    opts.status = [Status.open, Status.watching, Status.snoozed, Status.done];
  }

  const q = single(params.q);
  if (q && q.trim()) opts.q = q;

  const page = positiveInt(single(params.page));
  if (page !== undefined) opts.page = page;

  const perPage = positiveInt(single(params.per_page));
  if (perPage !== undefined) opts.per_page = perPage;

  return opts;
}

// Rebuild the canonical query string the server read used, so TriageList can replay it on retry
// (only the filter dimensions the list query honors — not wake_pending, which is fetched
// separately).
function buildQueryString(params: SearchParams): string {
  const usp = new URLSearchParams();
  const needsReview = single(params.needs_review) === 'true';
  for (const key of ['status', 'ministry', 'severity'] as const) {
    // In needs-review mode the server spans all lifecycle statuses; replay that explicit set so
    // the client revalidation (GET /api/tickets?…) matches — otherwise the API would default to
    // open-only and the list would diverge from the server snapshot on mount.
    if (key === 'status' && needsReview) {
      for (const s of [Status.open, Status.watching, Status.snoozed, Status.done]) {
        usp.append('status', s);
      }
      continue;
    }
    for (const v of asArray(params[key])) usp.append(key, v);
  }
  if (needsReview) usp.set('needs_review', 'true');
  const q = single(params.q);
  if (q && q.trim()) usp.set('q', q);
  const page = single(params.page);
  if (page) usp.set('page', page);
  const perPage = single(params.per_page);
  if (perPage) usp.set('per_page', perPage);
  return usp.toString();
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function single(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function filterEnum<T extends string>(
  values: string[],
  enumMap: Record<string, T>,
): T[] {
  const allowed = new Set<string>(Object.values(enumMap));
  return values.filter((v): v is T => allowed.has(v));
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
