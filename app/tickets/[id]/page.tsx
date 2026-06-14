import Link from 'next/link';
import { getTicket, type TicketWithComments } from '../../../lib/tickets';
import { MinistryTokens, SeverityTokens } from '../../../lib/tokens';
import { relativeTime } from '../../../lib/time';
import { EmptyState } from '../../../components/ui-states';
import { CommentBox } from '../../../components/CommentBox';
import { MinistryReassign } from '../../../components/MinistryReassign';
import { StatusControls } from '../../../components/StatusControls';

// Ticket detail view (FR-UI-3, FR-UI-4). Server Component: it reads the ticket + its full comment
// history in-process via getTicket(id, true) — the route is behind the session middleware, so
// private rows are always included here. Mirrors app/page.tsx: the server does the read, then
// hands interactivity (status controls, ministry re-assign, comment entry) to small client
// components. A missing ticket (or DB error) renders a real empty/error state, never a blank
// screen (house rule 6).
//
// Next 14 passes `params` as a plain (sync) prop; the read is synchronous, so the page is a sync
// Server Component like the triage page.

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  watching: 'Watching',
  snoozed: 'Snoozed',
  done: 'Done',
  archived: 'Archived',
};

export default function TicketDetailPage({
  params,
}: {
  params: { id: string };
}): React.JSX.Element {
  let ticket: TicketWithComments | null = null;
  let error = false;

  try {
    ticket = getTicket(params.id, true);
  } catch {
    error = true;
  }

  if (error) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <BackLink />
        <div
          className="mt-4 flex flex-col items-center gap-3 py-12 px-4 bg-red-50 rounded-lg border border-red-200"
          role="alert"
        >
          <p className="text-red-700 text-sm">Could not load this ticket.</p>
          <Link
            href={`/tickets/${params.id}`}
            className="text-sm text-red-700 underline hover:no-underline"
          >
            Retry
          </Link>
        </div>
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <BackLink />
        <EmptyState message="Ticket not found" />
      </main>
    );
  }

  const ministry = MinistryTokens[ticket.ministry];
  const severity = SeverityTokens[ticket.severity];

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <BackLink />

      {/* Header: title + badges on the left, status controls on the right. */}
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 break-words">
            {ticket.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`${ministry.bg} ${ministry.text} text-sm px-1.5 py-0.5 rounded font-medium`}
            >
              {ministry.label}
            </span>
            <span
              className={`${severity.bg} ${severity.text} text-sm px-1.5 py-0.5 rounded font-medium`}
            >
              {severity.label}
            </span>
            <span className="text-sm text-gray-600">
              {STATUS_LABEL[ticket.status] ?? ticket.status}
            </span>
            {ticket.needs_review && (
              <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-medium">
                Needs review
              </span>
            )}
            {ticket.private && (
              <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded font-medium">
                Private
              </span>
            )}
          </div>
        </div>
        <StatusControls ticketId={ticket.id} />
      </div>

      {/* Body. */}
      <section className="mt-6 bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">
          Details
        </h2>
        <p className="text-sm text-gray-800 whitespace-pre-wrap">{ticket.body}</p>
        {ticket.blocked_note && (
          <div className="mt-3 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            <span className="text-xs font-medium text-amber-800">Blocked: </span>
            <span className="text-sm text-amber-900">{ticket.blocked_note}</span>
          </div>
        )}
      </section>

      {/* Metadata + dedup observability + ministry re-assign. */}
      <section className="mt-4 bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-3">
          Metadata
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Ministry">
            <MinistryReassign ticketId={ticket.id} current={ticket.ministry} />
          </Field>
          <Field label="Type">
            <span className="text-gray-800">{ticket.ticket_type}</span>
          </Field>
          <Field label="Provenance">
            <span className="text-gray-800">{ticket.provenance}</span>
          </Field>
          <Field label="Source ref">
            <span className="text-gray-800 break-all">
              {ticket.source_ref ?? <span className="text-gray-400">—</span>}
            </span>
          </Field>

          {/* Dedup observability (FR-UI-3): dedup_key is OPAQUE — shown verbatim, never parsed. */}
          <Field label="Dedup key">
            {ticket.dedup_key ? (
              <code className="text-gray-800 break-all bg-gray-50 px-1 py-0.5 rounded">
                {ticket.dedup_key}
              </code>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Field>
          <Field label="Signals">
            <span className="text-gray-800">
              {ticket.event_count > 1
                ? `Merged from ${ticket.event_count} signals`
                : '1 signal'}
            </span>
          </Field>

          {ticket.status === 'snoozed' && ticket.snoozed_until && (
            <Field label="Snoozed until">
              <span className="text-gray-800">
                {relativeTime(ticket.snoozed_until)}
              </span>
            </Field>
          )}
          {ticket.linked_ticket_id && (
            <Field label="Linked ticket">
              <Link
                href={`/tickets/${ticket.linked_ticket_id}`}
                className="text-blue-700 underline hover:no-underline break-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
              >
                {ticket.linked_ticket_id}
              </Link>
            </Field>
          )}

          <Field label="Created">
            <span className="text-gray-800">{relativeTime(ticket.created_at)}</span>
          </Field>
          <Field label="Updated">
            <span className="text-gray-800">{relativeTime(ticket.updated_at)}</span>
          </Field>
          {ticket.closed_at && (
            <Field label="Closed">
              <span className="text-gray-800">{relativeTime(ticket.closed_at)}</span>
            </Field>
          )}
        </dl>
      </section>

      {/* Comments — chronological (created_at asc), author + relative time. */}
      <section className="mt-4 bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-3">
          Comments ({ticket.comments.length})
        </h2>
        {ticket.comments.length === 0 ? (
          <p className="text-sm text-gray-400">No comments yet</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {ticket.comments.map((c) => (
              <li key={c.id} className="border-b border-gray-100 last:border-0 pb-3 last:pb-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-gray-700">{c.author}</span>
                  <span className="text-xs text-gray-400">
                    {relativeTime(c.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        <CommentBox ticketId={ticket.id} />
      </section>
    </main>
  );
}

function BackLink(): React.JSX.Element {
  return (
    <Link
      href="/"
      className="text-sm text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded"
    >
      ← Back to triage
    </Link>
  );
}

// One label/value pair in the metadata grid. The label is a quiet caption; the value carries the
// real content (a string, a badge, a link, or an interactive control).
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
