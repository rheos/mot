'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriageRow, type TriageTicketView } from './TriageRow';
import { WakePending } from './WakePending';
import { FilterChips } from './FilterChips';
import { EmptyState, ErrorState } from './ui-states';
import { apiPath } from '../lib/client/base-path';

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

function listTitle(initial: InitialData): string {
  if (initial.needsReview) return 'Needs review';
  if (initial.query) return 'Filtered tickets';
  return 'Open tickets';
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
        fetch(apiPath(`/api/tickets${base}`), { cache: 'no-store' }),
        fetch(apiPath('/api/tickets?wake_pending=true'), { cache: 'no-store' }),
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

  // After any row action commits, re-query the server so the list reflects the DB — a resolved
  // ticket (done/watch/snooze) no longer matches the active filter and drops out of the view.
  function reload(): void {
    void load();
  }

  if (error) {
    return (
      <ErrorState message="Could not load tickets — try again" onRetry={retry} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterChips />
      <WakePending tickets={data.wakePending} onResolved={reload} />
      <section
        className="overflow-hidden rounded-[15px] border border-border bg-surface shadow-ministry-2"
        data-testid="open-list"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-[11px]">
          <h2 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
            {listTitle(initial)}
          </h2>
          <span className="text-[12.5px] text-ink-3">
            {data.tickets.length} {data.tickets.length === 1 ? 'ticket' : 'tickets'}
          </span>
        </div>
        {data.tickets.length === 0 ? (
          <div className="px-4 py-5">
            <EmptyState message={emptyMessage(initial)} />
          </div>
        ) : (
          <div>
            {data.tickets.map((t) => (
              <TriageRow
                key={t.id}
                ticket={t}
                showDismiss={initial.needsReview}
                onResolved={reload}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
