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
}

interface TriageData {
  tickets: TriageTicketView[];
  wakePending: TriageTicketView[];
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
        <EmptyState message="No open tickets" />
      ) : (
        <div
          className="border border-gray-200 rounded-lg overflow-hidden bg-white"
          data-testid="open-list"
        >
          {data.tickets.map((t) => (
            <TriageRow key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </div>
  );
}
