'use client';

import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';

// Shared UI-state primitives (house rule 6: every screen ships loading / empty / error /
// populated from day one). ErrorState always carries a retry affordance — failure is a
// moment for direction, not a dead end. Marked 'use client' because ErrorState takes an
// onRetry callback (a function prop can't cross the server→client boundary); LoadingState
// and EmptyState are pure and render in either context.

export function LoadingState(): React.JSX.Element {
  return (
    <StateShell
      icon={
        <Inbox
          aria-hidden="true"
          className="h-[26px] w-[26px] animate-pulse"
          strokeWidth={1.8}
        />
      }
      tone="neutral"
      role="status"
      ariaLive="polite"
      title="Loading…"
      body="Gathering the docket."
    />
  );
}

export function EmptyState({ message }: { message: string }): React.JSX.Element {
  return (
    <StateShell
      icon={<Inbox aria-hidden="true" className="h-[26px] w-[26px]" strokeWidth={1.8} />}
      tone="neutral"
      title={message}
      body="Nothing needs your attention here."
    />
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <StateShell
      icon={
        <AlertTriangle
          aria-hidden="true"
          className="h-[26px] w-[26px]"
          strokeWidth={1.8}
        />
      }
      tone="error"
      role="alert"
      title={message}
      body="The record could not be read."
    >
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border border-gold-line px-3 text-sm font-bold text-gold-bright hover:bg-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
          Retry
        </button>
      )}
    </StateShell>
  );
}

function StateShell({
  icon,
  tone,
  title,
  body,
  role,
  ariaLive,
  children,
}: {
  icon: React.ReactNode;
  tone: 'neutral' | 'error';
  title: string;
  body: string;
  role?: 'status' | 'alert';
  ariaLive?: 'polite' | 'assertive';
  children?: React.ReactNode;
}): React.JSX.Element {
  const isError = tone === 'error';

  return (
    <div
      className={`surface-card mx-auto flex max-w-xl flex-col items-center gap-3 px-5 py-12 text-center ${
        isError ? 'border-amber-line bg-amber-tint' : ''
      }`}
      role={role}
      aria-live={ariaLive}
    >
      <div
        className={`flex h-[58px] w-[58px] items-center justify-center rounded-[16px] border ${
          isError
            ? 'border-amber-line bg-[color-mix(in_srgb,var(--amber)_14%,var(--surface))] text-amber'
            : 'border-gold-line bg-[color-mix(in_srgb,var(--gold-soft)_15%,var(--surface))] text-gold-soft'
        }`}
      >
        {icon}
      </div>
      <div className="space-y-1">
        <h2 className="font-serif text-[15px] font-bold uppercase tracking-[0.18em] text-ink">
          {title}
        </h2>
        <p className="text-sm text-ink-2">{body}</p>
      </div>
      {children}
    </div>
  );
}
