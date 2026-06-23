'use client';

import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import type { ProceduralNote } from '../../lib/procedural';
import { apiPath } from '../../lib/client/base-path';
import { EmptyState, ErrorState } from '../ui-states';

// The interactive shell of the procedural-note browser (Track 4, Phase 4 — Recallatron). The
// Server page does the initial in-process read (confirmed + pending) and hands them in as
// initialData (react-nextjs §2: prefer initialData from the server parent over a client
// waterfall), so first paint is instant. Confirm is the ONLY write surface (FR-6.36 — no delete,
// no edit): it POSTs to the session-authed POST /api/memory/procedural/confirm route (NOT
// /api/mcp, which is API-key-only and would 401 the browser's session cookie) and, on success,
// moves the row Pending→Confirmed optimistically WITHOUT a full reload (AC-15). EC-8: an
// { error: 'already_confirmed' } body is treated as success (the note is already confirmed, so the
// row is removed from Pending all the same). All four states ship from day one (house rule 6):
// loading shows a per-button busy spinner, error renders inline + dismissible, empty shows copy on
// the Pending tab, populated is the note list.

type Tab = 'pending' | 'confirmed';

interface InitialData {
  confirmed: ProceduralNote[];
  pending: ProceduralNote[];
  error: boolean;
}

const TABS: { value: Tab; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
];

// A confirm response is either the updated note or a typed-error body. 'already_confirmed' is a
// success for our purposes (EC-8) — the note ends up confirmed either way.
type ConfirmResult = ProceduralNote | { error: string; [k: string]: unknown };

function isErrorBody(data: ConfirmResult): data is { error: string; [k: string]: unknown } {
  return typeof data === 'object' && data !== null && 'error' in data;
}

export function ProceduralBrowser({
  initialData,
}: {
  initialData: InitialData;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [pendingRows, setPendingRows] = useState<ProceduralNote[]>(initialData.pending);
  const [confirmedRows, setConfirmedRows] = useState<ProceduralNote[]>(initialData.confirmed);
  // Per-row in-flight tracking, so a row's Confirm button disables + spins while its POST is live.
  const [confirming, setConfirming] = useState<Set<number>>(new Set());
  // A single inline, dismissible action error (house rule 6). Initial-read failure also lands here.
  const [error, setError] = useState<string | null>(
    initialData.error ? 'Could not load procedural notes.' : null,
  );

  async function confirmRow(id: number): Promise<void> {
    setError(null);
    setConfirming((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(apiPath('/api/memory/procedural/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        cache: 'no-store',
      });
      const data = (await res.json()) as ConfirmResult;

      // Treat both a real success and 'already_confirmed' as confirmed (EC-8). Any other error —
      // an HTTP failure OR a typed 'not_found'/'superseded' body — leaves the row in Pending and
      // surfaces inline.
      const alreadyConfirmed = isErrorBody(data) && data.error === 'already_confirmed';
      if (!res.ok || (isErrorBody(data) && !alreadyConfirmed)) {
        const reason = isErrorBody(data) ? data.error : `HTTP ${res.status}`;
        setError(`Could not confirm note: ${reason}`);
        return;
      }

      // Optimistic move Pending→Confirmed without a full reload (AC-15).
      setPendingRows((prev) => prev.filter((n) => n.id !== id));
      // On a real success we have the updated note to show on the Confirmed tab. On
      // 'already_confirmed' we don't have the row shape, so we just drop it from Pending; it will
      // appear on the Confirmed tab on the next page load.
      if (!isErrorBody(data)) {
        setConfirmedRows((prev) => [data, ...prev]);
      }
    } catch {
      setError('Could not confirm note: request failed.');
    } finally {
      setConfirming((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const rows = activeTab === 'pending' ? pendingRows : confirmedRows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h1 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
          Procedural notes
        </h1>

        {/* Tabs — same inline Tailwind idiom as the entities filter strip. */}
        <div
          role="tablist"
          aria-label="Procedural notes filter"
          className="flex items-center gap-2 overflow-x-auto pb-px"
          data-testid="procedural-tabs"
        >
          {TABS.map((t) => {
            const isActive = activeTab === t.value;
            const count = t.value === 'pending' ? pendingRows.length : confirmedRows.length;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`tab-${t.value}`}
                onClick={() => setActiveTab(t.value)}
                className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  isActive
                    ? 'border-gold-line bg-[color-mix(in_srgb,var(--gold)_12%,var(--surface))] text-ink'
                    : 'border-border bg-surface text-ink-2 hover:border-gold-line hover:text-ink'
                }`}
              >
                {t.label}
                <span className="rounded-ministry-xs border border-border bg-surface-2 px-[7px] py-px text-[11px] font-bold text-ink-3">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Inline, dismissible action error (house rule 6). */}
      {error && (
        <div
          role="alert"
          data-testid="procedural-error"
          className="flex items-start justify-between gap-3 rounded-[12px] border border-amber-line bg-amber-tint px-4 py-3 text-sm text-amber"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            data-testid="dismiss-error"
            className="shrink-0 rounded-ministry-xs p-0.5 text-amber hover:bg-[color-mix(in_srgb,var(--amber)_14%,transparent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <X aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}

      <section
        className="overflow-hidden rounded-[15px] border border-border bg-surface shadow-ministry-2"
        data-testid="procedural-list"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-[11px]">
          <h2 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
            {activeTab === 'pending' ? 'Pending review' : 'Confirmed notes'}
          </h2>
          <span className="text-[12.5px] text-ink-3">
            {rows.length} {rows.length === 1 ? 'note' : 'notes'}
          </span>
        </div>

        {initialData.error ? (
          <div className="px-4 py-5">
            <ErrorState message="Could not load procedural notes" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-5">
            <EmptyState
              message={activeTab === 'pending' ? 'No pending notes' : 'No confirmed notes'}
            />
          </div>
        ) : (
          <ul>
            {rows.map((note) => (
              <li
                key={note.id}
                data-testid="procedural-row"
                className="flex flex-col gap-2 border-b border-hair px-4 py-[13px] last:border-0"
              >
                <p className="break-words text-sm text-ink">{note.note}</p>
                <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                  <span className="rounded-ministry-xs border border-border bg-surface-2 px-[9px] py-[3px] font-bold tracking-[0.02em] text-ink-2">
                    {note.category}
                  </span>
                  <span className="truncate">
                    session{' '}
                    <code className="break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                      {note.source_session_id}
                    </code>
                  </span>
                  <span>{note.created_at}</span>
                </div>

                {activeTab === 'pending' && (
                  <div>
                    <button
                      type="button"
                      onClick={() => void confirmRow(note.id)}
                      disabled={confirming.has(note.id)}
                      aria-busy={confirming.has(note.id)}
                      data-testid="confirm-button"
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border border-gold-line px-3 text-sm font-bold text-gold-bright transition hover:bg-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {confirming.has(note.id) ? (
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" strokeWidth={2} />
                      ) : (
                        <Check aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                      )}
                      Confirm
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
