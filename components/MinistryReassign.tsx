'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Pencil } from 'lucide-react';
import { Ministry } from '../lib/enums';
import { MinistryTokens } from '../lib/tokens';
import { apiPath } from '../lib/client/base-path';

// One-click ministry re-assignment on the detail view (FR-UI-3). A compact branded dropdown of
// all eight ministries PATCHes { ministry } and refreshes the Server Component so the badge
// updates. No confirmation modal (the spec doesn't require one). Selecting the current
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
  const ministry = MinistryTokens[current];

  async function reassign(ministry: string): Promise<void> {
    if (ministry === current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiPath(`/api/tickets/${ticketId}`), {
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
    <div className="flex flex-col gap-1.5">
      <div className="inline-flex max-w-full items-center gap-2 rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink transition focus-within:border-gold-line">
        <span
          aria-hidden="true"
          className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
          style={{
            background: `color-mix(in srgb, ${ministry.hue} 16%, transparent)`,
            border: `1px solid color-mix(in srgb, ${ministry.hue} 28%, transparent)`,
          }}
        />
        <select
          value={current}
          disabled={busy || isPending}
          aria-label="Reassign ministry"
          onChange={(e) => void reassign(e.target.value)}
          className="min-w-0 bg-transparent text-sm text-ink outline-none disabled:opacity-50"
        >
          {Object.values(Ministry).map((m) => (
            <option key={m} value={m}>
              {MinistryTokens[m].label}
            </option>
          ))}
        </select>
        <Pencil aria-hidden="true" className="h-[13px] w-[13px] shrink-0 text-ink-3" />
      </div>
      {error && <p className="text-xs text-amber">{error}</p>}
    </div>
  );
}
