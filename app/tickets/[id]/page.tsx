import Link from 'next/link';
import {
  ArrowLeft,
  Banknote,
  Globe,
  GraduationCap,
  Hammer,
  House,
  PiggyBank,
  ShieldCheck,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { getTicket, listTickets, type TicketWithComments } from '../../../lib/tickets';
import { MinistryTokens, SeverityTokens } from '../../../lib/tokens';
import { relativeTime } from '../../../lib/time';
import { EmptyState } from '../../../components/ui-states';
import { CommentBox } from '../../../components/CommentBox';
import { MinistryReassign } from '../../../components/MinistryReassign';
import { StatusControls } from '../../../components/StatusControls';
import { CopyButton } from '../../../components/CopyButton';

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

const MinistryIcons: Record<string, LucideIcon> = {
  Hammer,
  Banknote,
  PiggyBank,
  ShieldCheck,
  GraduationCap,
  Waves,
  House,
  Globe,
};

export default function TicketDetailPage({
  params,
}: {
  params: { id: string };
}): React.JSX.Element {
  let ticket: TicketWithComments | null = null;
  let nextTicketId: string | undefined;
  let error = false;

  try {
    ticket = getTicket(params.id, true);
    // Find the next ticket in the default open list so "Done" can advance automatically.
    const openList = listTickets({ includePrivate: true }).tickets;
    const idx = openList.findIndex((t) => t.id === params.id);
    if (idx !== -1 && idx + 1 < openList.length) {
      nextTicketId = openList[idx + 1].id;
    }
  } catch {
    error = true;
  }

  if (error) {
    return (
      <main className="mx-auto max-w-[760px] px-5 py-[18px] pb-10">
        <BackLink />
        <div
          className="surface-card mt-4 flex flex-col items-center gap-3 px-4 py-12"
          role="alert"
        >
          <p className="text-sm text-amber">Could not load this ticket.</p>
          <Link
            href={`/tickets/${params.id}`}
            className="rounded-ministry-sm border border-gold-line px-3 py-2 text-sm font-bold text-gold-bright hover:bg-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            Retry
          </Link>
        </div>
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className="mx-auto max-w-[760px] px-5 py-[18px] pb-10">
        <BackLink />
        <EmptyState message="Ticket not found" />
      </main>
    );
  }

  const ministry = MinistryTokens[ticket.ministry];
  const severity = SeverityTokens[ticket.severity];
  const MinistryIcon = MinistryIcons[ministry.icon] ?? Hammer;

  return (
    <main className="mx-auto max-w-[760px] px-5 py-[18px] pb-10">
      <BackLink />

      <div className="mt-4 flex items-start gap-[15px]">
        <span
          className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-ministry border shadow-[inset_0_1px_0_rgba(255,255,255,.04)]"
          style={{
            color: ministry.hue,
            background: `color-mix(in srgb, ${ministry.hue} 15%, var(--surface))`,
            borderColor: `color-mix(in srgb, ${ministry.hue} 30%, transparent)`,
          }}
        >
          <MinistryIcon aria-hidden="true" className="h-[27px] w-[27px]" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-[22px] font-bold leading-tight text-ink">
            {ticket.title}
          </h1>
          <div className="mt-[11px] flex flex-wrap items-center gap-2">
            <span
              className="rounded-ministry-xs border px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em]"
              style={{
                color: severity.color,
                background: `color-mix(in srgb, ${severity.color} 14%, transparent)`,
                borderColor: `color-mix(in srgb, ${severity.color} 30%, transparent)`,
              }}
            >
              {severity.label}
            </span>
            <span
              className="rounded-ministry-xs border px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em]"
              style={{
                color: ministry.hue,
                background: `color-mix(in srgb, ${ministry.hue} 14%, transparent)`,
                borderColor: `color-mix(in srgb, ${ministry.hue} 28%, transparent)`,
              }}
            >
              {ministry.label}
            </span>
            <Tag>
              {STATUS_LABEL[ticket.status] ?? ticket.status}
            </Tag>
            {ticket.needs_review && (
              <Tag className="border-amber-line bg-amber-tint text-amber">
                Needs review
              </Tag>
            )}
            {ticket.private && <Tag>Private</Tag>}
          </div>
          {/* The opaque ticket reference — visible and one-click copyable to hand to the assistant
              (it resolves the id via mot_get_ticket). */}
          <div className="mt-[10px]">
            <CopyButton
              value={ticket.id}
              title="Copy ticket ID"
              iconClassName="h-3.5 w-3.5 shrink-0"
              className="inline-flex max-w-full items-center gap-2 rounded-ministry-xs border border-border bg-surface-2 px-[9px] py-[4px] font-mono text-[12px] text-ink-2 transition hover:border-gold-line hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-ink-3">
                ID
              </span>
              <span className="break-all">{ticket.id}</span>
            </CopyButton>
          </div>
        </div>
      </div>

      <div className="mt-[18px]">
        <StatusControls ticketId={ticket.id} status={ticket.status} nextTicketId={nextTicketId} />
      </div>

      <DetailCard title="Details">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">
          {ticket.body || '—'}
        </p>
        {ticket.blocked_note && (
          <div className="mt-3 rounded-ministry-sm border border-amber-line bg-amber-tint px-3 py-2">
            <span className="text-xs font-bold text-amber">Blocked: </span>
            <span className="text-sm text-ink-2">{ticket.blocked_note}</span>
          </div>
        )}
      </DetailCard>

      <DetailCard title="Metadata">
        <dl className="grid grid-cols-1 gap-x-[22px] gap-y-4 sm:grid-cols-2">
          <Field label="Ministry">
            <MinistryReassign ticketId={ticket.id} current={ticket.ministry} />
          </Field>
          <Field label="Type">
            {ticket.ticket_type}
          </Field>
          <Field label="Provenance">
            {ticket.provenance}
          </Field>
          <Field label="Status">
            {STATUS_LABEL[ticket.status] ?? ticket.status}
          </Field>
          <Field label="Source ref">
            <CodeValue value={ticket.source_ref} />
          </Field>

          {/* Dedup observability (FR-UI-3): dedup_key is OPAQUE — shown verbatim, never parsed. */}
          <Field label="Dedup key">
            <CodeValue value={ticket.dedup_key} />
          </Field>
          <Field label="Signals">
            {ticket.event_count > 1
              ? `Merged from ${ticket.event_count} signals`
              : '1 signal'}
          </Field>

          {ticket.status === 'snoozed' && ticket.snoozed_until && (
            <Field label="Snoozed until">
              {relativeTime(ticket.snoozed_until)}
            </Field>
          )}
          {ticket.linked_ticket_id && (
            <Field label="Linked ticket">
              <Link
                href={`/tickets/${ticket.linked_ticket_id}`}
                className="break-all rounded text-gold-bright underline underline-offset-2 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                {ticket.linked_ticket_id}
              </Link>
            </Field>
          )}

          <Field label="Created">
            {relativeTime(ticket.created_at)}
          </Field>
          <Field label="Updated">
            {relativeTime(ticket.updated_at)}
          </Field>
          {ticket.closed_at && (
            <Field label="Closed">
              {relativeTime(ticket.closed_at)}
            </Field>
          )}
        </dl>
      </DetailCard>

      <DetailCard title={`Comments (${ticket.comments.length})`}>
        {ticket.comments.length === 0 ? (
          <p className="text-sm text-ink-3">No comments yet</p>
        ) : (
          <ul>
            {ticket.comments.map((c) => (
              <li
                key={c.id}
                className="border-b border-hair py-[13px] first:pt-0 last:border-0 last:pb-0"
              >
                <div className="flex items-baseline gap-[9px]">
                  <span
                    className={`text-[13.5px] font-bold ${
                      c.author === 'tuttle' ? 'text-teal-bright' : 'text-ink'
                    }`}
                  >
                    {c.author === 'tuttle' ? 'Tuttle' : c.author}
                  </span>
                  <span className="text-[11.5px] text-ink-faint">
                    {relativeTime(c.created_at)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                  {c.body}
                </p>
              </li>
            ))}
          </ul>
        )}
        <CommentBox ticketId={ticket.id} />
      </DetailCard>
    </main>
  );
}

function BackLink(): React.JSX.Element {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-[7px] rounded text-[13px] text-ink-3 transition hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
      Back to triage
    </Link>
  );
}

function DetailCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-4 rounded-ministry border border-border bg-surface p-[18px] shadow-ministry-2">
      <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-gold-soft">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Tag({
  children,
  className = 'border-border bg-surface-2 text-ink-2',
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={`rounded-ministry-xs border px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em] ${className}`}
    >
      {children}
    </span>
  );
}

function CodeValue({ value }: { value: string | null }): React.JSX.Element {
  if (!value) return <span className="text-ink-3">—</span>;

  return (
    <code className="break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[12.5px] text-ink-2">
      {value}
    </code>
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
      <dt className="text-[11.5px] tracking-[0.04em] text-ink-3">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}
