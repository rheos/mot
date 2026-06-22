'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Flag,
  Globe,
  Layers,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Ministry, Status, Severity } from '../lib/enums';
import { MinistryTokens, SeverityTokens } from '../lib/tokens';

// Filter controls for the triage list (FR-UI-2). Ministry / status / severity multi-selects
// that write repeated URL params (?status=open&status=watching) — AND semantics across the
// three dimensions, multi-OR within one dimension, fully bookmarkable. Toggling a value does a
// shallow router.push (no full reload); the Server page re-queries from the new params. Active
// values render as dismissible chips with a Clear action that resets to the default view.

// The lifecycle statuses the UI exposes as filters (archived is cron-only, never a UI filter).
const FILTER_STATUSES = ['open', 'watching', 'snoozed', 'done'] as const;

const StatusLabels: Record<(typeof FILTER_STATUSES)[number], string> = {
  open: 'Open',
  watching: 'Watching',
  snoozed: 'Snoozed',
  done: 'Done',
};

export function FilterChips(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = {
    status: searchParams.getAll('status'),
    ministry: searchParams.getAll('ministry'),
    severity: searchParams.getAll('severity'),
  };
  const needsReview = searchParams.get('needs_review') === 'true';

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

  // Needs-review preset (FR-UI-6): a queue spanning ALL statuses. Activating it sets
  // needs_review=true and clears the status filters (the queue is not scoped to one status);
  // deactivating just drops the param and returns to the default open list. q is preserved.
  function toggleNeedsReview(): void {
    const params = new URLSearchParams(searchParams.toString());
    if (needsReview) {
      params.delete('needs_review');
    } else {
      params.set('needs_review', 'true');
      params.delete('status');
    }
    params.delete('page');
    router.push(params.toString() ? `/?${params.toString()}` : '/');
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

  useEffect(() => {
    function onDocumentPointerDown(e: PointerEvent): void {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenGroup(null);
    }
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="sticky top-[117px] z-30 flex flex-col gap-[9px] border-b border-hair bg-bg px-[18px] py-3 sm:top-[67px]"
    >
      <div
        className="flex items-center gap-2 overflow-x-auto pb-px"
        style={{ scrollbarWidth: 'none' }}
      >
        <FilterGroup
          label="Status"
          icon={Layers}
          isOpen={openGroup === 'status'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'status' ? null : 'status'))
          }
          options={FILTER_STATUSES.map((s) => ({ value: s, label: StatusLabels[s] }))}
          activeValues={active.status}
          onToggle={(v) => toggle('status', v)}
        />
        <FilterGroup
          label="Ministry"
          icon={Globe}
          isOpen={openGroup === 'ministry'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'ministry' ? null : 'ministry'))
          }
          options={Object.values(Ministry).map((m) => ({
            value: m,
            label: MinistryTokens[m].label,
            swatch: MinistryTokens[m].hue,
            swatchShape: 'dot',
          }))}
          activeValues={active.ministry}
          onToggle={(v) => toggle('ministry', v)}
        />
        <FilterGroup
          label="Severity"
          icon={Flag}
          isOpen={openGroup === 'severity'}
          onToggleOpen={() =>
            setOpenGroup((g) => (g === 'severity' ? null : 'severity'))
          }
          options={Object.values(Severity).map((s) => ({
            value: s,
            label: SeverityTokens[s].label,
            swatch: SeverityTokens[s].color,
            swatchShape: 'square',
          }))}
          activeValues={active.severity}
          onToggle={(v) => toggle('severity', v)}
        />
        <button
          type="button"
          onClick={toggleNeedsReview}
          aria-pressed={needsReview}
          data-testid="needs-review-toggle"
          className={`inline-flex h-9 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
            needsReview
              ? 'border-amber-line bg-amber-tint text-amber'
              : 'border-border bg-surface text-ink-2 hover:border-gold-line hover:text-ink'
          }`}
        >
          <Flag aria-hidden="true" className="h-3.5 w-3.5 opacity-80" strokeWidth={1.9} />
          Needs review
        </button>
        {(hasActive || needsReview) && (
          <button
            type="button"
            onClick={clearAll}
            className="shrink-0 rounded text-[12.5px] text-ink-3 underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            Clear
          </button>
        )}
      </div>

      {hasActive && (
        <div className="flex flex-wrap items-center gap-[7px]" data-testid="active-chips">
          {active.status.map((v) => (
            <Chip
              key={`status-${v}`}
              kind="Status"
              label={statusLabel(v)}
              onRemove={() => toggle('status', v)}
            />
          ))}
          {active.ministry.map((v) => (
            <Chip
              key={`ministry-${v}`}
              kind="Ministry"
              label={MinistryTokens[v as keyof typeof MinistryTokens]?.label ?? v}
              onRemove={() => toggle('ministry', v)}
            />
          ))}
          {active.severity.map((v) => (
            <Chip
              key={`severity-${v}`}
              kind="Severity"
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
  icon: Icon,
  isOpen,
  onToggleOpen,
  options,
  activeValues,
  onToggle,
}: {
  label: string;
  icon: LucideIcon;
  isOpen: boolean;
  onToggleOpen: () => void;
  options: Array<{
    value: string;
    label: string;
    swatch?: string;
    swatchShape?: 'dot' | 'square';
  }>;
  activeValues: string[];
  onToggle: (value: string) => void;
}): React.JSX.Element {
  const activeCount = activeValues.length;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The chip row is overflow-x-auto (horizontal scroll), which forces overflow-y to clip — an
  // absolutely positioned menu would be cut off by it. Anchor the menu with position:fixed
  // (escapes the clip) computed from the button rect, recomputed on scroll/resize. It stays a DOM
  // child of the bar, so the wrapRef outside-click handler still counts clicks inside it.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 7, left: r.left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [isOpen]);

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className={`inline-flex h-9 items-center gap-[7px] whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
          activeCount > 0
            ? 'border-gold-line bg-[color-mix(in_srgb,var(--gold)_12%,var(--surface))] text-ink'
            : 'border-border bg-surface text-ink-2 hover:border-gold-line hover:text-ink'
        }`}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5 opacity-80" strokeWidth={1.9} />
        {label}
        {activeCount > 0 && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-gold px-1 text-[11px] font-bold text-on-gold">
            {activeCount}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={`h-[13px] w-[13px] transition-transform ${isOpen ? 'rotate-180' : ''}`}
          strokeWidth={1.9}
        />
      </button>
      {isOpen && (
        <div
          style={
            pos
              ? { position: 'fixed', top: pos.top, left: pos.left }
              : { position: 'fixed', visibility: 'hidden' }
          }
          className="z-50 flex min-w-[210px] flex-col gap-px rounded-[13px] border border-border bg-surface p-[7px] shadow-pop"
        >
          {options.map((opt) => {
            const checked = activeValues.includes(opt.value);
            return (
              <button
                type="button"
                key={opt.value}
                aria-pressed={checked}
                onClick={() => onToggle(opt.value)}
                className={`flex w-full items-center gap-[11px] rounded-[8px] px-[11px] py-[9px] text-left text-sm transition hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  checked ? 'text-ink' : 'text-ink-2'
                }`}
              >
                <span
                  className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] ${
                    checked
                      ? 'border-gold bg-gold text-on-gold'
                      : 'border-border text-transparent'
                  }`}
                >
                  <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
                </span>
                {opt.swatch && (
                  <span
                    aria-hidden="true"
                    className={`h-[9px] w-[9px] shrink-0 ${
                      opt.swatchShape === 'square' ? 'rounded-sm' : 'rounded-full'
                    }`}
                    style={{ backgroundColor: opt.swatch }}
                  />
                )}
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({
  kind,
  label,
  onRemove,
}: {
  kind: string;
  label: string;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-1.5 text-[12.5px] text-ink-2">
      <span>
        {kind}: <b className="font-semibold text-ink">{label}</b>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${kind}: ${label} filter`}
        className="grid h-[18px] w-[18px] place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <X aria-hidden="true" className="h-[11px] w-[11px]" strokeWidth={2.5} />
      </button>
    </span>
  );
}

function statusLabel(value: string): string {
  return StatusLabels[value as keyof typeof StatusLabels] ?? value;
}
