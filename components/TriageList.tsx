'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriageRow, type TriageTicketView } from './TriageRow';
import { WakePending } from './WakePending';
import { FilterChips } from './FilterChips';
import { EmptyState, ErrorState } from './ui-states';

// The interactive shell of the triage view (FR-UI-1). The Server page does the initial in-process
// read and hands the result in as initialData (react-nextjs §2: prefer initialData from the
// server parent over a client waterfall) — so first paint is instant, no loading flash. On mount
// the list revalidates once against GET /api/tickets to stay live; that client path is also what
// surfaces the four states: a failed fetch (e.g. the API down) renders ErrorState with a real
// Retry, rather than a silently stale or blank list (house rule 6).

interface InitialData {
  tickets: TriageTicketView[];
  wakePending: TriageTicketView[];
  error: boolean;
  query: string; // the raw URL query string the server used, to replay on refetch
  q?: string; // active keyword search term (drives the empty-result copy)
  needsReview?: boolean; // needs-review preset active (drives the empty-result copy)
}

interface TriageData {
  tickets: TriageTicketView[];
  wakePending: TriageTicketView[];
}

// The empty-result copy is context-specific (frontend-design: an empty screen is direction, not a
// dead end). A search with no hits says what was searched; the needs-review queue says the queue
// is clear; the plain list says there's nothing open.
function emptyMessage(initial: InitialData): string {
  if (initial.q) return `No tickets match '${initial.q}'`;
  if (initial.needsReview) return 'No items need review';
  return 'No open tickets';
}

export function TriageList({ initial }: { initial: InitialData }): React.JSX.Element {
  const router = useRouter();
  const [data, setData] = useState<TriageData>({
    tickets: initial.tickets,
    wakePending: initial.wakePending,
  });
  const [error, setError] = useState<boolean>(initial.error);
  const fetchedFor = useRef<string | null>(null);

  async function load(): Promise<void> {
    try {
      const base = initial.query ? `?${initial.query}` : '';
      const [listRes, wakeRes] = await Promise.all([
        fetch(`/api/tickets${base}`, { cache: 'no-store' }),
        fetch('/api/tickets?wake_pending=true', { cache: 'no-store' }),
      ]);
      if (!listRes.ok || !wakeRes.ok) throw new Error('Could not load tickets');
      const list = (await listRes.json()) as { tickets: TriageTicketView[] };
      const wake = (await wakeRes.json()) as { tickets: TriageTicketView[] };
      setData({ tickets: list.tickets, wakePending: wake.tickets });
      setError(false);
    } catch {
      setError(true);
    }
  }

  // Revalidate once per query string after first paint. initialData already covers the instant
  // render; this keeps the list honest if the API and the server snapshot diverge, and is the
  // path an API outage takes to ErrorState.
  useEffect(() => {
    if (fetchedFor.current === initial.query) return;
    fetchedFor.current = initial.query;
    void load();
    // initial.query is the stable key; load is recreated each render but only fired once per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.query]);

  function retry(): void {
    setError(false);
    fetchedFor.current = null;
    void load();
    router.refresh();
  }

  if (error) {
    return (
      <ErrorState message="Could not load tickets — try again" onRetry={retry} />
    );
  }

  return (
    <div>
      <WakePending tickets={data.wakePending} />
      <FilterChips />
      {data.tickets.length === 0 ? (
        <EmptyState message={emptyMessage(initial)} />
      ) : (
        <div
          className="border border-gray-200 rounded-lg overflow-hidden bg-white"
          data-testid="open-list"
        >
          {data.tickets.map((t) => (
            <TriageRow key={t.id} ticket={t} showDismiss={initial.needsReview} />
          ))}
        </div>
      )}
    </div>
  );
}
