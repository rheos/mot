'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { SnoozePopover } from './SnoozePopover';
import { patchTicketClient } from '../lib/client/triage';

// Watch / Snooze / Done controls for the ticket detail view (FR-UI-3). Same three actions the
// triage row exposes, here in the detail header. Each PATCHes the API (session cookie sent
// automatically) and refreshes the Server Component so the status badge and fields update in
// place. Reuses SnoozePopover (the native datetime-local picker, future-only guard) so the
// snooze affordance matches the list exactly.
export function StatusControls({
  ticketId,
}: {
  ticketId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || isPending;

  async function act(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const ok = await patchTicketClient(ticketId, payload);
    setBusy(false);
    if (!ok) {
      setError('Action failed — try again');
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          onClick={() => void act({ status: 'watching' })}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          Watch
        </button>
        <SnoozePopover
          disabled={disabled}
          onSnooze={(iso) => act({ status: 'snoozed', snoozed_until: iso })}
        />
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          onClick={() => void act({ status: 'done' })}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          Done
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
