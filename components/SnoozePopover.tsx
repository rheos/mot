'use client';

import { useId, useRef, useState } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const customId = useId();

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

  return (
    <div className={isTray ? 'relative flex' : 'relative'}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
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

      {open && (
        <div
          role="dialog"
          aria-label="Snooze until"
          className="fixed inset-x-4 bottom-4 z-[60] flex max-h-[calc(100vh-2rem)] flex-col gap-1 overflow-auto rounded-[13px] border border-border bg-surface p-2 text-ink shadow-pop sm:absolute sm:bottom-auto sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[260px]"
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
            ref={inputRef}
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
              onClick={() => {
                setOpen(false);
                setValue('');
                setError(null);
              }}
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
      )}
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
