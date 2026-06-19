'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock } from 'lucide-react';

type SnoozeVariant = 'default' | 'icon' | 'tray';

const quickOptions = [
  {
    label: 'In 1 hour',
    sub: '60 min',
    when: () => new Date(Date.now() + 60 * 60 * 1000),
  },
  {
    label: 'This evening',
    sub: '7 PM',
    when: () => nextAt(0, 19),
  },
  {
    label: 'Tomorrow',
    sub: '9 AM',
    when: () => nextAt(1, 9, true),
  },
  {
    label: 'This weekend',
    sub: 'Sat 9 AM',
    when: () => nextWeekdayAt(6, 9, true),
  },
  {
    label: 'Next week',
    sub: 'Mon 9 AM',
    when: () => nextWeekdayAt(1, 9),
  },
];

// Snooze affordance: quick future picks plus the native datetime-local fallback. The chosen
// time is rejected client-side if it is in the past before any request goes out; the backend
// enforces the same rule. On a valid future pick it calls onSnooze with a full ISO string.
//
// The menu renders through a portal to <body>, NOT as a child of the row. The triage row and the
// list <section> both clip with overflow-hidden (for the mobile swipe tray and the rounded card),
// which would otherwise cut the menu off at the row edge and let the next row paint over it. From
// the portal the menu is anchored to the trigger via getBoundingClientRect (desktop) or shown as a
// bottom sheet (mobile), so it floats above everything regardless of which row opened it.
export function SnoozePopover({
  disabled,
  onSnooze,
  variant = 'default',
}: {
  disabled: boolean;
  onSnooze: (iso: string) => void | Promise<void>;
  variant?: SnoozeVariant;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  // null → mobile bottom-sheet (positioned by CSS classes); a style object → desktop, anchored to
  // the trigger button with fixed coordinates.
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const customId = useId();

  // Compute the menu position from the trigger's viewport rect. Desktop only — on narrow screens
  // we fall back to the full-width bottom sheet (menuStyle = null). Flips above the button when
  // there isn't room below, and caps max-height to the available space (the menu scrolls inside).
  const place = useCallback((): void => {
    const btn = buttonRef.current;
    if (!btn) return;
    if (!window.matchMedia('(min-width: 640px)').matches) {
      setMenuStyle(null);
      return;
    }
    const r = btn.getBoundingClientRect();
    const m = 8;
    const width = 260;
    const right = Math.max(m, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom - m;
    const above = r.top - m;
    const base: React.CSSProperties = { position: 'fixed', right, width };
    if (below >= 280 || below >= above) {
      setMenuStyle({ ...base, top: r.bottom + m, maxHeight: Math.max(160, below) });
    } else {
      setMenuStyle({ ...base, bottom: window.innerHeight - r.top + m, maxHeight: Math.max(160, above) });
    }
  }, []);

  function toggle(): void {
    setError(null);
    if (!open) {
      place(); // position synchronously so the first paint is already anchored (no flash)
      setOpen(true);
    } else {
      setOpen(false);
    }
  }

  function close(): void {
    setOpen(false);
    setValue('');
    setError(null);
  }

  // While open: keep the menu glued to the button as the list scrolls/resizes, and close on an
  // outside click or Escape (a floating, portaled menu has no natural dismiss otherwise).
  useEffect(() => {
    if (!open) return;
    place();
    const onScrollResize = (): void => place();
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  function pick(when: Date): void {
    if (Number.isNaN(when.getTime()) || when <= new Date()) {
      setError('Must be a future time');
      return;
    }
    setError(null);
    setOpen(false);
    setValue('');
    void onSnooze(when.toISOString());
  }

  function submit(): void {
    if (!value) {
      setError('Pick a time');
      return;
    }
    // A datetime-local value has no timezone; new Date() reads it as local time, which is what
    // the operator means. Reject anything not strictly in the future.
    const when = new Date(value);
    if (Number.isNaN(when.getTime()) || when <= new Date()) {
      setError('Must be a future time');
      return;
    }
    setError(null);
    setOpen(false);
    setValue('');
    void onSnooze(when.toISOString());
  }

  const isIcon = variant === 'icon';
  const isTray = variant === 'tray';

  const menu = (
    <div
      ref={menuRef}
      role="dialog"
      aria-label="Snooze until"
      style={menuStyle ?? undefined}
      className={
        menuStyle
          ? 'z-[60] flex flex-col gap-1 overflow-auto rounded-[13px] border border-border bg-surface p-2 text-ink shadow-pop'
          : 'fixed inset-x-4 bottom-4 z-[60] flex max-h-[calc(100vh-2rem)] flex-col gap-1 overflow-auto rounded-[13px] border border-border bg-surface p-2 text-ink shadow-pop'
      }
    >
      <div className="flex items-center gap-2 px-2 pb-1 pt-1 text-[11px] uppercase tracking-[0.1em] text-ink-3">
        <AlarmClock aria-hidden="true" className="h-4 w-4 text-gold" strokeWidth={1.9} />
        Snooze until
      </div>
      {quickOptions.map((option) => (
        <button
          key={option.label}
          type="button"
          onClick={() => pick(option.when())}
          className="flex w-full items-center justify-between rounded-[8px] px-2.5 py-2 text-left text-[13.5px] text-ink-2 transition hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <span>{option.label}</span>
          <span className="text-xs text-ink-faint">{option.sub}</span>
        </button>
      ))}
      <div className="mt-1 border-t border-hair px-2 pt-3">
        <label
          htmlFor={customId}
          className="block text-[11px] font-bold uppercase tracking-[0.12em] text-ink-3"
        >
          Pick a time
        </label>
      </div>
      <input
        id={customId}
        type="datetime-local"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        className="mx-2 rounded-ministry-sm border border-border bg-surface-2 px-2 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      />
      {error && <p className="px-2 text-xs text-amber">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={close}
          className="rounded-ministry-sm px-3 py-2 text-xs font-bold text-ink-3 hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded-ministry-sm border border-gold-line bg-gold px-3 py-2 text-xs font-bold text-on-gold hover:bg-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          Snooze
        </button>
      </div>
    </div>
  );

  return (
    <div className={isTray ? 'relative flex' : 'relative'}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={isIcon ? 'Snooze' : undefined}
        title={isIcon ? 'Snooze' : undefined}
        className={
          isTray
            ? 'flex w-[78px] flex-col items-center justify-center gap-1 border-0 bg-[#7a6326] text-[11px] font-bold tracking-[0.04em] text-white disabled:opacity-50'
            : isIcon
              ? 'grid h-[34px] w-[34px] place-items-center rounded-[8px] border border-border bg-surface text-ink-2 transition hover:border-[#8a7330] hover:text-[#d9b85e] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold'
              : 'inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border border-border bg-surface px-3 text-sm font-bold text-ink-2 transition hover:border-gold-line hover:text-gold-bright disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold'
        }
      >
        <AlarmClock
          aria-hidden="true"
          className={isTray ? 'h-[19px] w-[19px]' : 'h-4 w-4'}
          strokeWidth={1.9}
        />
        {!isIcon && 'Snooze'}
      </button>

      {open && typeof document !== 'undefined' && createPortal(menu, document.body)}
    </div>
  );
}

function nextAt(dayOffset: number, hour: number, forceTomorrow = false): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  if (forceTomorrow) return d;
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}

function nextWeekdayAt(weekday: number, hour: number, allowToday = false): Date {
  const d = new Date();
  const today = d.getDay();
  let days = (weekday - today + 7) % 7;
  if (days === 0 && !allowToday) days = 7;
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 7);
  return d;
}
