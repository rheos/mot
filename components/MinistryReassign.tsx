'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Ministry } from '../lib/enums';
import { MinistryTokens } from '../lib/tokens';

// One-click ministry re-assignment on the detail view (FR-UI-3). A plain dropdown of all eight
// ministries; selecting a new one PATCHes { ministry } and refreshes the Server Component so the
// badge updates. No confirmation modal (the spec doesn't require one). Selecting the current
// ministry is a no-op. On the backend this also back-fills the latest classification_audit row's
// corrected_ministry (FR-API-2b) — a correction signal for Phase 2, invisible here.
export function MinistryReassign({
  ticketId,
  current,
}: {
  ticketId: string;
  current: Ministry;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reassign(ministry: string): Promise<void> {
    if (ministry === current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ministry }),
      });
      if (!res.ok) throw new Error('Reassign failed');
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reassign — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={current}
        disabled={busy || isPending}
        aria-label="Reassign ministry"
        onChange={(e) => void reassign(e.target.value)}
        className="text-sm border border-gray-300 rounded px-2 py-1 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        {Object.values(Ministry).map((m) => (
          <option key={m} value={m}>
            {MinistryTokens[m].label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
