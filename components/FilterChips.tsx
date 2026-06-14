'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Ministry, Status, Severity } from '../lib/enums';
import { MinistryTokens, SeverityTokens } from '../lib/tokens';

// Filter controls for the triage list (FR-UI-2). Ministry / status / severity multi-selects
// that write repeated URL params (?status=open&status=watching) — AND semantics across the
// three dimensions, multi-OR within one dimension, fully bookmarkable. Toggling a value does a
// shallow router.push (no full reload); the Server page re-queries from the new params. Active
// values render as dismissible chips with a "Clear all" that resets to the default (status=open).

// The lifecycle statuses the UI exposes as filters (archived is cron-only, never a UI filter).
const FILTER_STATUSES = ['open', 'watching', 'snoozed', 'done'] as const;

export function FilterChips(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const active = {
    status: searchParams.getAll('status'),
    ministry: searchParams.getAll('ministry'),
    severity: searchParams.getAll('severity'),
  };

  // Toggle one value within a param group, preserving q and resetting to page 1.
  function toggle(key: 'status' | 'ministry' | 'severity', value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    const current = params.getAll(key);
    params.delete(key);
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    for (const v of next) params.append(key, v);
    params.delete('page');
    router.push(`/?${params.toString()}`);
  }

  function clearAll(): void {
    // Reset to the default view. Preserve an active search term if one is set.
    const params = new URLSearchParams();
    const q = searchParams.get('q');
    if (q) params.set('q', q);
    router.push(params.toString() ? `/?${params.toString()}` : '/');
  }

  const hasActive =
    active.status.length > 0 ||
    active.ministry.length > 0 ||
    active.severity.length > 0;

  return (
    <div className="flex flex-col gap-2 px-3 py-2 border-b border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-2">
        <FilterGroup
          label="Status"
          isOpen={openGroup === 'status'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'status' ? null : 'status'))
          }
          options={FILTER_STATUSES.map((s) => ({ value: s, label: s }))}
          activeValues={active.status}
          onToggle={(v) => toggle('status', v)}
        />
        <FilterGroup
          label="Ministry"
          isOpen={openGroup === 'ministry'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'ministry' ? null : 'ministry'))
          }
          options={Object.values(Ministry).map((m) => ({
            value: m,
            label: MinistryTokens[m].label,
          }))}
          activeValues={active.ministry}
          onToggle={(v) => toggle('ministry', v)}
        />
        <FilterGroup
          label="Severity"
          isOpen={openGroup === 'severity'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'severity' ? null : 'severity'))
          }
          options={Object.values(Severity).map((s) => ({
            value: s,
            label: SeverityTokens[s].label,
          }))}
          activeValues={active.severity}
          onToggle={(v) => toggle('severity', v)}
        />
        {hasActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-gray-500 underline hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded"
          >
            Clear all filters
          </button>
        )}
      </div>

      {hasActive && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="active-chips">
          {active.status.map((v) => (
            <Chip key={`status-${v}`} label={`status: ${v}`} onRemove={() => toggle('status', v)} />
          ))}
          {active.ministry.map((v) => (
            <Chip
              key={`ministry-${v}`}
              label={MinistryTokens[v as keyof typeof MinistryTokens]?.label ?? v}
              onRemove={() => toggle('ministry', v)}
            />
          ))}
          {active.severity.map((v) => (
            <Chip
              key={`severity-${v}`}
              label={SeverityTokens[v as keyof typeof SeverityTokens]?.label ?? v}
              onRemove={() => toggle('severity', v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  isOpen,
  onToggleOpen,
  options,
  activeValues,
  onToggle,
}: {
  label: string;
  isOpen: boolean;
  onToggleOpen: () => void;
  options: Array<{ value: string; label: string }>;
  activeValues: string[];
  onToggle: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        {label}
        {activeValues.length > 0 && (
          <span className="ml-1 text-gray-500">({activeValues.length})</span>
        )}
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full mt-1 z-10 w-40 bg-white border border-gray-200 rounded-lg shadow-md p-1 flex flex-col">
          {options.map((opt) => {
            const checked = activeValues.includes(opt.value);
            return (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(opt.value)}
                  className="accent-gray-900"
                />
                <span className="capitalize">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 rounded-full pl-2 pr-1 py-0.5">
      <span className="capitalize">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="rounded-full w-4 h-4 flex items-center justify-center hover:bg-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        ×
      </button>
    </span>
  );
}
