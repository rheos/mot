'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlarmClock, ChevronDown, RefreshCw } from 'lucide-react';
import { TriageRow, type TriageTicketView } from './TriageRow';
import { apiPath } from '../lib/client/base-path';

// Wake-pending section (FR-UI-5, AC-EC8): snoozed tickets whose snoozed_until is now in the
// past. Collapsible, amber-tinted warning header. "Wake all" fans out one PATCH /tickets/:id
// per ticket (status: 'open') via Promise.all — there is NO batch endpoint, by design. Each
// row is individually actionable with the standard triage controls (reuses TriageRow).
export function WakePending({
  tickets,
  onResolved,
}: {
  tickets: TriageTicketView[];
  // Bubbled up from the parent list: re-query the server after an action commits so woken /
  // resolved rows leave this section (and the open list) without a full page refresh.
  onResolved?: () => void;
}): React.JSX.Element | null {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (tickets.length === 0) return null;

  async function wakeAll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // No batch endpoint exists — fan out individual PATCHes, one per ticket.
      const results = await Promise.all(
        tickets.map((t) =>
          fetch(apiPath(`/api/tickets/${t.id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'open' }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) {
        throw new Error('One or more tickets failed to wake');
      }
      if (onResolved) {
        onResolved();
      } else {
        startTransition(() => router.refresh());
      }
    } catch {
      setError('Some tickets could not be woken — try again');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || isPending;

  return (
    <section
      className="overflow-hidden rounded-[13px] border border-amber-line bg-amber-tint"
      data-collapsed={collapsed}
      data-testid="wake-pending"
    >
      <div className="flex items-center justify-between gap-3 px-[14px] py-[11px]">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-[9px] rounded text-[13.5px] font-bold tracking-[0.02em] text-amber focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            strokeWidth={1.9}
          />
          <AlarmClock aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
          Wake pending ({tickets.length})
        </button>
        <button
          type="button"
          onClick={() => void wakeAll()}
          disabled={disabled}
          aria-busy={disabled}
          className="inline-flex items-center gap-1.5 rounded-[8px] border border-amber-line px-3 py-1.5 text-[12.5px] font-semibold text-amber transition hover:bg-[color-mix(in_srgb,var(--amber)_14%,transparent)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${disabled ? 'animate-spin' : ''}`}
            strokeWidth={1.9}
          />
          {disabled ? 'Waking…' : 'Wake all'}
        </button>
      </div>
      {error && <p className="px-[14px] pb-2 text-xs text-amber">{error}</p>}
      {!collapsed && (
        <div className="border-t border-amber-line bg-surface">
          {tickets.map((t) => (
            <TriageRow key={t.id} ticket={t} onResolved={onResolved} />
          ))}
        </div>
      )}
    </section>
  );
}
