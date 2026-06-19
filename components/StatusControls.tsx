'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Check, Eye, Inbox } from 'lucide-react';
import type { Status } from '../lib/enums';
import { SnoozePopover } from './SnoozePopover';
import { patchTicketClient } from '../lib/client/triage';

// Detail status controls (FR-UI-3): Open / Watch / Snooze / Done. Each action PATCHes the
// API through the shared client helper and refreshes the Server Component so the status badge
// and metadata update in place. Snooze reuses the shared SnoozePopover from the list.
export function StatusControls({
  ticketId,
  status,
}: {
  ticketId: string;
  status: Status;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || isPending;

  async function act(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const ok = await patchTicketClient(ticketId, payload);
    setBusy(false);
    if (!ok) {
      setError('Action failed — try again');
      return;
    }
    startTransition(() => router.refresh());
  }

  const buttonBase =
    'inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border px-3 text-sm font-bold transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const buttonTone =
    'border-border bg-surface text-ink-2 hover:border-gold-line hover:text-ink';
  const currentTone = 'border-gold bg-gold text-on-gold';

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          aria-pressed={status === 'open'}
          onClick={() => void act({ status: 'open' })}
          className={`${buttonBase} ${status === 'open' ? currentTone : buttonTone}`}
        >
          <Inbox aria-hidden="true" className="h-[15px] w-[15px]" strokeWidth={1.9} />
          Open
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          aria-pressed={status === 'watching'}
          onClick={() => void act({ status: 'watching' })}
          className={`${buttonBase} ${status === 'watching' ? currentTone : buttonTone}`}
        >
          <Eye aria-hidden="true" className="h-[15px] w-[15px]" strokeWidth={1.9} />
          Watch
        </button>
        <span
          className={
            status === 'snoozed'
              ? '[&_button:first-child]:border-gold [&_button:first-child]:bg-gold [&_button:first-child]:text-on-gold'
              : ''
          }
        >
          <SnoozePopover
            disabled={disabled}
            onSnooze={(iso) => act({ status: 'snoozed', snoozed_until: iso })}
          />
        </span>
        <button
          type="button"
          disabled={disabled}
          aria-busy={disabled}
          aria-pressed={status === 'done'}
          onClick={() => void act({ status: 'done' })}
          className={`${buttonBase} ${status === 'done' ? currentTone : buttonTone}`}
        >
          <Check aria-hidden="true" className="h-[15px] w-[15px]" strokeWidth={2} />
          Done
        </button>
      </div>
      {error && <p className="text-xs text-amber">{error}</p>}
    </div>
  );
}
