'use client';

import { useRef, useState } from 'react';

// Snooze affordance: a "Snooze" button that reveals an inline popover with a native
// <input type="datetime-local"> (no custom calendar — visual notes). The chosen time is
// rejected client-side if it is in the past ("Must be a future time") before any request goes
// out — the backend enforces the same rule (EC-ARCH-4), this is the fast local guard. On a
// valid future pick it calls onSnooze with a full ISO string and closes.
export function SnoozePopover({
  disabled,
  onSnooze,
}: {
  disabled: boolean;
  onSnooze: (iso: string) => void | Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        Snooze
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Snooze until"
          className="absolute right-0 top-full mt-1 z-10 w-60 bg-white border border-gray-200 rounded-lg shadow-md p-3 flex flex-col gap-2"
        >
          <label className="text-xs font-medium text-gray-600">Snooze until</label>
          <input
            ref={inputRef}
            type="datetime-local"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue('');
                setError(null);
              }}
              className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="text-xs px-2 py-1 rounded bg-gray-900 text-white hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
            >
              Snooze
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
