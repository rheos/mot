'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { EntityRecord } from '../../lib/graph';
import { apiPath } from '../../lib/client/base-path';
import { EmptyState, ErrorState, LoadingState } from '../ui-states';

// The interactive shell of the entity browser (Track 4, Phase 4 — Recallatron). The Server page
// does the initial in-process read (active + unconfirmed) and hands them in as initialData
// (react-nextjs §2: prefer initialData from the server parent over a client waterfall), so first
// paint is instant. Filtering and live search go back over GET /api/memory/entities (no-store) so
// the list stays honest; that client path is also what surfaces loading and error (house rule 6).
//
// Filter note: the existing FilterChips component is URL-param-driven (useSearchParams +
// router.push) — it cannot be applied here without writing query params, so per the build prompt
// this uses plain inline Tailwind tab buttons in the same visual idiom instead.

type Filter = 'all' | 'confirmed' | 'unconfirmed';

interface InitialData {
  active: EntityRecord[];
  unconfirmed: EntityRecord[];
  error: boolean;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'unconfirmed', label: 'Unconfirmed' },
];

function emptyMessage(filter: Filter, q: string): string {
  if (q.trim()) return `No entities match '${q.trim()}'`;
  if (filter === 'unconfirmed') return 'No unconfirmed entities';
  if (filter === 'confirmed') return 'No confirmed entities';
  return 'No entities found';
}

export function EntityBrowser({
  initialData,
}: {
  initialData: InitialData;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const [searchQ, setSearchQ] = useState('');
  const [entities, setEntities] = useState<EntityRecord[]>(initialData.active);
  const [selected, setSelected] = useState<EntityRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<boolean>(initialData.error);
  // The query the in-flight/last fetch was issued for, so a retry can replay it.
  const lastQuery = useRef<{ q: string; filter: Filter }>({ q: '', filter: 'all' });

  // Re-query the route whenever the search term or filter changes. The 'confirmed' filter is a
  // client-side narrowing of the active set (the route has no confirmed_only flag), so it does
  // NOT trigger a fetch on its own — it filters whatever the current active result holds.
  async function runSearch(q: string, f: Filter): Promise<void> {
    lastQuery.current = { q, filter: f };
    setLoading(true);
    setError(false);
    try {
      const unconfirmedOnly = f === 'unconfirmed';
      const params = new URLSearchParams();
      params.set('q', q);
      if (unconfirmedOnly) params.set('unconfirmed_only', 'true');
      const res = await fetch(apiPath(`/api/memory/entities?${params.toString()}`), {
        cache: 'no-store',
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as EntityRecord[];
      setEntities(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // Debounce the live search so we don't fire a request per keystroke. Re-runs whenever the term
  // or filter changes (primitive deps — react-nextjs §6). The leading mount uses the
  // server-provided initialData.active, so we skip the very first fetch when nothing has changed.
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      // Only the active filter is already covered by initialData; for an initial 'unconfirmed'
      // (not reachable on mount, but future-proof) we would still need to fetch.
      if (filter !== 'unconfirmed' && searchQ === '') return;
    }
    const handle = setTimeout(() => void runSearch(searchQ, filter), 200);
    return () => clearTimeout(handle);
    // searchQ + filter are the stable primitive keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, filter]);

  function retry(): void {
    void runSearch(lastQuery.current.q, lastQuery.current.filter);
  }

  // 'confirmed' is a client-side narrowing of the active result; 'all' and 'unconfirmed' are
  // already exactly what the route returned for the active/unconfirmed read.
  const visible =
    filter === 'confirmed'
      ? entities.filter((e) => e.confirmed === true)
      : entities;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h1 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
          Entities
        </h1>

        {/* Filter tabs — inline Tailwind (FilterChips is URL-param-driven; see header note). */}
        <div
          role="tablist"
          aria-label="Entity filter"
          className="flex items-center gap-2 overflow-x-auto pb-px"
          data-testid="entity-filter"
        >
          {FILTERS.map((f) => {
            const isActive = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`filter-${f.value}`}
                onClick={() => {
                  setFilter(f.value);
                  setSelected(null);
                }}
                className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  isActive
                    ? 'border-gold-line bg-[color-mix(in_srgb,var(--gold)_12%,var(--surface))] text-ink'
                    : 'border-border bg-surface text-ink-2 hover:border-gold-line hover:text-ink'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Live search */}
        <label className="relative block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
            strokeWidth={1.9}
          />
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search entities…"
            aria-label="Search entities"
            data-testid="entity-search"
            className="h-9 w-full rounded-full border border-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 focus:border-gold-line focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          />
        </label>
      </div>

      {/* Two-column on wide screens: list + detail panel. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section
          className="overflow-hidden rounded-[15px] border border-border bg-surface shadow-ministry-2"
          data-testid="entity-list"
        >
          <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-[11px]">
            <h2 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
              {filter === 'unconfirmed'
                ? 'Unconfirmed'
                : filter === 'confirmed'
                  ? 'Confirmed'
                  : 'Active entities'}
            </h2>
            <span className="text-[12.5px] text-ink-3">
              {visible.length} {visible.length === 1 ? 'entity' : 'entities'}
            </span>
          </div>

          {error ? (
            <div className="px-4 py-5">
              <ErrorState
                message="Could not load entities — try again"
                onRetry={retry}
              />
            </div>
          ) : loading ? (
            <div className="px-4 py-5">
              <LoadingState />
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-5">
              <EmptyState message={emptyMessage(filter, searchQ)} />
            </div>
          ) : (
            <ul>
              {visible.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    aria-pressed={selected?.id === e.id}
                    data-testid="entity-row"
                    className={`flex w-full flex-col items-start gap-1 border-b border-hair px-4 py-[13px] text-left transition last:border-0 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                      selected?.id === e.id ? 'bg-surface-2' : ''
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="truncate font-semibold text-ink">{e.label}</span>
                      <span className="shrink-0 rounded-ministry-xs border border-border bg-surface-2 px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em] text-ink-2">
                        {e.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                      <span>conf {e.confidence.toFixed(2)}</span>
                      {!e.confirmed && (
                        <span className="rounded-ministry-xs border border-amber-line bg-amber-tint px-[7px] py-px font-bold text-amber">
                          Unconfirmed
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Detail panel */}
        <section
          className="rounded-[15px] border border-border bg-surface p-[18px] shadow-ministry-2"
          data-testid="entity-detail"
        >
          {selected ? (
            <EntityDetail entity={selected} />
          ) : (
            <p className="text-sm text-ink-3">Select an entity to see its details.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function EntityDetail({ entity }: { entity: EntityRecord }): React.JSX.Element {
  // GAP #4: nothing populates properties.relations today (no extraction, entity_create, or
  // edge-write path exists yet — verified against the codebase). The sub-panel reads
  // entity.properties.relations directly so it lights up automatically when edge-writing ships;
  // until then it renders an explicit "No relations" empty state, NOT a blank gap (house rule 6
  // — an empty surface is by-design direction, not a missing-data bug).
  const relations = entity.properties.relations ?? [];

  // Render properties as a key/value list, but pull `relations` out so it isn't double-shown in
  // the raw dump below.
  const { relations: _relations, ...restProps } = entity.properties;
  const propEntries = Object.entries(restProps);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-[18px] font-bold leading-tight text-ink">
            {entity.label}
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-3">{entity.type}</p>
        </div>
        <span
          className={`shrink-0 rounded-ministry-xs border px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em] ${
            entity.superseded_by === null
              ? 'border-border bg-surface-2 text-ink-2'
              : 'border-amber-line bg-amber-tint text-amber'
          }`}
        >
          {entity.superseded_by === null
            ? 'Active'
            : `Superseded by ${entity.superseded_by}`}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-x-[22px] gap-y-3">
        <Field label="Confidence">{entity.confidence.toFixed(2)}</Field>
        <Field label="Confirmed">{entity.confirmed ? 'Yes' : 'No'}</Field>
        <Field label="Valid from">{entity.valid_from}</Field>
        <Field label="Source">
          <code className="break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[12px] text-ink-2">
            {entity.source}
          </code>
        </Field>
      </dl>

      {/* Relations sub-panel (GAP #4) */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gold-soft">
          Relations
        </h3>
        {relations.length === 0 ? (
          <p className="text-sm text-ink-3" data-testid="no-relations">
            No relations
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="relations-list">
            {relations.map((r, i) => (
              <li
                key={`${r.rel}-${r.target_id}-${i}`}
                className="flex items-center gap-2 text-sm text-ink-2"
              >
                <span className="font-semibold text-ink">{r.rel}</span>
                <span className="text-ink-3">→</span>
                <code className="break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[12px] text-ink-2">
                  {r.target_id}
                </code>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Raw properties */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gold-soft">
          Properties
        </h3>
        {propEntries.length === 0 ? (
          <p className="text-sm text-ink-3">No properties</p>
        ) : (
          <dl className="flex flex-col gap-2">
            {propEntries.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <dt className="text-[11.5px] tracking-[0.04em] text-ink-3">{k}</dt>
                <dd className="break-words text-sm text-ink-2">
                  {typeof v === 'string' ? v : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11.5px] tracking-[0.04em] text-ink-3">{label}</dt>
      <dd className="break-words text-sm text-ink">{children}</dd>
    </div>
  );
}
