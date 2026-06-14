'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MinistryTokens, SeverityTokens } from '../lib/tokens';
import { relativeTime } from '../lib/time';
import { SnoozePopover } from './SnoozePopover';
import type { Ministry, Severity } from '../lib/enums';

// The data a single triage row needs. A narrow, fully serializable slice of the stored Ticket
// (house rule: minimize what crosses the server→client boundary) — the Server page maps full
// rows down to this before handing them to the client list.
export interface TriageTicketView {
  id: string;
  title: string;
  ministry: Ministry;
  severity: Severity;
  ticket_type: string;
  needs_review: boolean;
  event_count: number;
  updated_at: string;
}

// One compact triage row (~52px): ministry badge, severity badge, title, type, signal count,
// relative time, and inline Watch / Snooze / Done. Clicking the row body opens the detail view
// (Prompt 12); clicking a control does NOT navigate (the buttons stop propagation). Each action
// PATCHes the API with the session cookie (sent automatically) and refreshes the server data.
export function TriageRow({
  ticket,
}: {
  ticket: TriageTicketView;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ministry = MinistryTokens[ticket.ministry];
  const severity = SeverityTokens[ticket.severity];
  const disabled = busy || isPending;

  async function triageAction(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Triage action failed');
      // Re-run the Server Component query so the row reflects its new status.
      startTransition(() => router.refresh());
    } catch {
      setError('Action failed — try again');
    } finally {
      setBusy(false);
    }
  }

  function openDetail(): void {
    router.push(`/tickets/${ticket.id}`);
  }

  return (
    <div
      className="group flex items-center gap-3 px-3 min-h-[52px] py-2 border-b border-gray-100 bg-white hover:bg-gray-50 cursor-pointer"
      onClick={openDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail();
        }
      }}
      data-testid="triage-row"
    >
      <span
        className={`${ministry.bg} ${ministry.text} text-sm px-1.5 py-0.5 rounded font-medium shrink-0`}
      >
        {ministry.label}
      </span>
      <span
        className={`${severity.bg} ${severity.text} text-sm px-1.5 py-0.5 rounded font-medium shrink-0`}
      >
        {severity.label}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base text-gray-900 truncate">{ticket.title}</span>
          {ticket.needs_review && (
            <span className="text-xs bg-yellow-100 text-yellow-700 px-1 rounded shrink-0">
              needs review
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <span className="truncate">{ticket.ticket_type}</span>
          {ticket.event_count > 1 && (
            <span className="text-xs text-gray-500 shrink-0">
              {ticket.event_count} signals
            </span>
          )}
          <span className="text-xs text-gray-400 shrink-0">
            {relativeTime(ticket.updated_at)}
          </span>
        </div>
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </div>

      {/* Inline actions. Each stops propagation so the row click (→ detail) does not fire. */}
      <div
        className="flex items-center gap-1 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          onClick={() => void triageAction({ status: 'watching' })}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          Watch
        </button>
        <SnoozePopover
          disabled={disabled}
          onSnooze={(iso) =>
            triageAction({ status: 'snoozed', snoozed_until: iso })
          }
        />
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          onClick={() => void triageAction({ status: 'done' })}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          Done
        </button>
      </div>
    </div>
  );
}
