'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { TriageRow, type TriageTicketView } from './TriageRow';
import { apiPath } from '../lib/client/base-path';

// Wake-pending section (FR-UI-5, AC-EC8): snoozed tickets whose snoozed_until is now in the
// past. Collapsible, amber-tinted warning header. "Wake all" fans out one PATCH /tickets/:id
// per ticket (status: 'open') via Promise.all — there is NO batch endpoint, by design. Each
// row is individually actionable with the standard triage controls (reuses TriageRow).
export function WakePending({
  tickets,
}: {
  tickets: TriageTicketView[];
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
      startTransition(() => router.refresh());
    } catch {
      setError('Some tickets could not be woken — try again');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || isPending;

  return (
    <section
      className="border border-amber-200 bg-amber-50 rounded-lg mb-4 overflow-hidden"
      data-testid="wake-pending"
    >
      <div className="flex items-center justify-between px-4 py-2 bg-amber-50">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-sm font-medium text-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          Wake pending ({tickets.length})
        </button>
        <button
          type="button"
          onClick={() => void wakeAll()}
          disabled={disabled}
          aria-busy={disabled}
          className="text-xs px-3 py-1 rounded border border-amber-400 text-amber-800 hover:bg-amber-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
        >
          {disabled ? 'Waking…' : 'Wake all'}
        </button>
      </div>
      {error && <p className="px-4 pb-2 text-xs text-red-600">{error}</p>}
      {!collapsed && (
        <div className="bg-white border-t border-amber-200">
          {tickets.map((t) => (
            <TriageRow key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </section>
  );
}
