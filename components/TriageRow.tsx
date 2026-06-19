'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import {
  Banknote,
  Check,
  Eye,
  Flag,
  Globe,
  GraduationCap,
  Hammer,
  House,
  Layers,
  Lock,
  PiggyBank,
  ShieldCheck,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MinistryTokens, SeverityTokens } from '../lib/tokens';
import { relativeTime } from '../lib/time';
import { SnoozePopover } from './SnoozePopover';
import type { Ministry, Severity } from '../lib/enums';
import { apiPath } from '../lib/client/base-path';

const TRAY_WIDTH = 234; // 3 x 78px mobile actions
const DONE_THRESHOLD = TRAY_WIDTH + 30;

const MinistryIcons: Record<string, LucideIcon> = {
  Hammer,
  Banknote,
  PiggyBank,
  ShieldCheck,
  GraduationCap,
  Waves,
  House,
  Globe,
};

// The data a single triage row needs. A narrow, fully serializable slice of the stored Ticket
// (house rule: minimize what crosses the server→client boundary) — the Server page maps full
// rows down to this before handing them to the client list.
export interface TriageTicketView {
  id: string;
  title: string;
  ministry: Ministry;
  severity: Severity;
  ticket_type: string;
  needs_review: boolean;
  private: boolean;
  event_count: number;
  updated_at: string;
}

// Token-driven triage row: ministry tile, severity accent, title flags, meta line, and
// desktop/mobile action affordances. Clicking the row body opens the detail view; clicking a
// control does NOT navigate. Each action PATCHes the API with the session cookie and refreshes.
export function TriageRow({
  ticket,
  showDismiss = false,
  onResolved,
}: {
  ticket: TriageTicketView;
  // In the needs-review queue (FR-UI-6) each row gets a Dismiss action that clears the
  // needs_review flag. Off everywhere else.
  showDismiss?: boolean;
  // Called after a triage action commits (HTTP 200). The parent list re-queries the server so
  // this row drops out of (or updates within) the current view. Absent → fall back to a refresh.
  onResolved?: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ministry = MinistryTokens[ticket.ministry];
  const severity = SeverityTokens[ticket.severity];
  const MinistryIcon = MinistryIcons[ministry.icon] ?? Hammer;
  const disabled = busy || isPending;
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    moved: boolean;
    currentX: number;
  } | null>(null);
  const moved = useRef(false);

  async function triageAction(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiPath(`/api/tickets/${ticket.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Triage action failed');
      // The PATCH committed (200) — the DB now holds the new status. Ask the parent list to
      // re-query the server so this row reflects reality (a done/watch/snooze drops it from the
      // open view). Falls back to a full refresh when rendered without a parent handler.
      if (onResolved) {
        onResolved();
      } else {
        startTransition(() => router.refresh());
      }
    } catch {
      setError('Action failed — try again');
    } finally {
      setBusy(false);
    }
  }

  function openDetail(): void {
    router.push(`/tickets/${ticket.id}`);
  }

  function dot(): React.JSX.Element {
    return (
      <span
        aria-hidden="true"
        className="h-[3px] w-[3px] shrink-0 rounded-full bg-ink-faint"
      />
    );
  }

  function resetTray(): void {
    setDragX(0);
  }

  function trayAction(payload: Record<string, unknown>): void {
    resetTray();
    void triageAction(payload);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.pointerType !== 'touch') return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: dragX,
      moved: false,
      currentX: dragX,
    };
    moved.current = false;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      setDragging(false);
      setDragX(0);
      drag.current = null;
      return;
    }
    if (Math.abs(dx) > 5) drag.current.moved = true;
    const next = Math.max(
      -(DONE_THRESHOLD + 48),
      Math.min(0, drag.current.baseX + dx),
    );
    drag.current.currentX = next;
    setDragX(next);
  }

  function onPointerUp(): void {
    if (!drag.current) return;
    const current = drag.current.currentX;
    moved.current = drag.current.moved;
    drag.current = null;
    setDragging(false);
    if (current <= -DONE_THRESHOLD) {
      setDragX(0);
      void triageAction({ status: 'done' });
      return;
    }
    setDragX(current <= -TRAY_WIDTH / 2 ? -TRAY_WIDTH : 0);
  }

  function rowClick(): void {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (dragX < -8) {
      resetTray();
      return;
    }
    openDetail();
  }

  const rowTransform = dragX ? `translateX(${dragX}px)` : undefined;
  const doneStretch = Math.max(0, Math.min(48, -dragX - TRAY_WIDTH));
  const rowWash =
    ticket.severity === 'critical'
      ? 'shadow-[inset_0_0_0_100vmax_rgba(224,71,92,.04)]'
      : '';
  const actionClass =
    'grid h-[34px] w-[34px] place-items-center rounded-[8px] border border-border bg-surface text-ink-2 transition hover:text-ink disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';

  return (
    <div className="relative overflow-hidden border-b border-hair bg-surface last:border-b-0">
      <div className="absolute inset-y-0 right-0 flex items-stretch sm:hidden">
        <button
          type="button"
          disabled={disabled}
          aria-label="Watch"
          onClick={() => trayAction({ status: 'watching' })}
          className="flex w-[78px] flex-col items-center justify-center gap-1 border-0 bg-[#3a5a72] text-[11px] font-bold tracking-[0.04em] text-white disabled:opacity-50"
        >
          <Eye aria-hidden="true" className="h-[19px] w-[19px]" strokeWidth={1.9} />
          Watch
        </button>
        <SnoozePopover
          disabled={disabled}
          variant="tray"
          onSnooze={(iso) =>
            trayAction({ status: 'snoozed', snoozed_until: iso })
          }
        />
        <button
          type="button"
          disabled={disabled}
          aria-label="Done"
          onClick={() => trayAction({ status: 'done' })}
          className="flex flex-col items-center justify-center gap-1 border-0 bg-[#2f7350] text-[11px] font-bold tracking-[0.04em] text-white disabled:opacity-50"
          style={{ width: 78 + doneStretch }}
        >
          <Check aria-hidden="true" className="h-[19px] w-[19px]" strokeWidth={2} />
          Done
        </button>
      </div>

      <div
        className={`group relative flex min-h-[76px] cursor-pointer touch-pan-y items-center gap-[13px] bg-surface px-[15px] py-[14px] transition-colors hover:bg-surface-2 ${rowWash}`}
        style={{
          transform: rowTransform,
          transition: dragging
            ? 'none'
            : 'transform .26s cubic-bezier(.4,0,.2,1), background-color .15s ease',
        }}
        onClick={rowClick}
        role="button"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openDetail();
          }
        }}
        data-testid="triage-row"
      >
        <span
          aria-hidden="true"
          className="absolute bottom-[9px] left-0 top-[9px] w-[3px] rounded-r-[3px]"
          style={{ backgroundColor: severity.bar }}
        />

        <span
          className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[12px] border shadow-[inset_0_1px_0_rgba(255,255,255,.04)]"
          style={{
            color: ministry.hue,
            background: `color-mix(in srgb, ${ministry.hue} 15%, var(--surface))`,
            borderColor: `color-mix(in srgb, ${ministry.hue} 30%, transparent)`,
          }}
        >
          <MinistryIcon aria-hidden="true" className="h-[23px] w-[23px]" strokeWidth={1.8} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start gap-[9px]">
            <span
              className="min-w-0 flex-1 overflow-hidden text-[15.5px] font-semibold leading-[1.3] text-ink"
              style={{
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
              }}
            >
              {ticket.title}
            </span>
            <span className="flex shrink-0 items-center gap-[7px] pt-px">
              {ticket.needs_review && (
                <span className="inline-flex items-center gap-1 rounded-[5px] border border-amber-line bg-amber-tint px-1.5 py-px text-[10.5px] font-bold text-amber">
                  <Flag aria-hidden="true" className="h-[11px] w-[11px]" strokeWidth={1.8} />
                  review
                </span>
              )}
              {ticket.private && (
                <span
                  className="inline-grid place-items-center text-ink-faint"
                  aria-label="Private"
                  title="Private"
                >
                  <Lock aria-hidden="true" className="h-3 w-3" strokeWidth={1.9} />
                </span>
              )}
              <span
                className="shrink-0 whitespace-nowrap text-[10px] font-extrabold uppercase leading-[1.5] tracking-[0.1em]"
                style={{ color: severity.color }}
              >
                {severity.label}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2 overflow-hidden text-[12.5px] text-ink-3">
            <span
              className="shrink-0 whitespace-nowrap font-semibold"
              style={{ color: ministry.hue }}
            >
              {ministry.short}
            </span>
            {dot()}
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              {ticket.ticket_type}
            </span>
            {ticket.event_count > 1 && (
              <>
                {dot()}
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                  <Layers aria-hidden="true" className="h-3 w-3" strokeWidth={1.8} />
                  {ticket.event_count} signals
                </span>
              </>
            )}
            {dot()}
            <span className="shrink-0 whitespace-nowrap">
              {relativeTime(ticket.updated_at)}
            </span>
          </div>
          {error && <p className="text-xs text-amber">{error}</p>}
        </div>

        <div
          className="pointer-events-none hidden shrink-0 translate-x-1.5 items-center gap-[5px] opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-focus-within:pointer-events-auto sm:flex"
          onClick={(e) => e.stopPropagation()}
        >
          {showDismiss && (
            <button
              type="button"
              disabled={disabled}
              aria-busy={disabled}
              aria-label="Dismiss review"
              title="Dismiss review"
              onClick={() => void triageAction({ needs_review: false })}
              className={`${actionClass} hover:border-amber-line hover:text-amber`}
            >
              <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            aria-busy={disabled}
            aria-label="Watch"
            title="Watch"
            onClick={() => void triageAction({ status: 'watching' })}
            className={`${actionClass} hover:border-[#4a7290] hover:text-[#7fb4d8]`}
          >
            <Eye aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <SnoozePopover
            disabled={disabled}
            variant="icon"
            onSnooze={(iso) =>
              triageAction({ status: 'snoozed', snoozed_until: iso })
            }
          />
          <button
            type="button"
            disabled={disabled}
            aria-busy={disabled}
            aria-label="Done"
            title="Done"
            onClick={() => void triageAction({ status: 'done' })}
            className={`${actionClass} hover:border-[#3a7a58] hover:text-[#5fc08a]`}
          >
            <Check aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
