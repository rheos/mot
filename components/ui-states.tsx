'use client';

// Shared UI-state primitives (house rule 6: every screen ships loading / empty / error /
// populated from day one). ErrorState always carries a retry affordance — failure is a
// moment for direction, not a dead end. Marked 'use client' because ErrorState takes an
// onRetry callback (a function prop can't cross the server→client boundary); LoadingState
// and EmptyState are pure and render in either context.

export function LoadingState(): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-center py-16 text-gray-400 text-sm"
      role="status"
      aria-live="polite"
    >
      <span className="animate-pulse">Loading…</span>
    </div>
  );
}

export function EmptyState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
      {message}
    </div>
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
    <div
      className="flex flex-col items-center gap-3 py-12 px-4 bg-red-50 rounded-lg border border-red-200"
      role="alert"
    >
      <p className="text-red-700 text-sm">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-sm text-red-700 underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
        >
          Retry
        </button>
      )}
    </div>
  );
}
