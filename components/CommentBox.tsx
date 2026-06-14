'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Inline comment entry on the ticket detail view (FR-UI-4). Author is always `robin` (the sole
// human operator; `tuttle` is the system author for dedup/cascade comments). A non-empty body is
// required before any request goes out — the empty case is rejected client-side. On success the
// box clears and router.refresh() re-runs the Server Component, so the new comment appears in the
// chronological list with no full page reload.
export function CommentBox({
  ticketId,
}: {
  ticketId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = body.trim();

  async function submit(): Promise<void> {
    if (!trimmed) return; // empty rejected before request
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add_comment: { author: 'robin', body: trimmed } }),
      });
      if (!res.ok) throw new Error('Failed to add comment');
      setBody('');
      router.refresh();
    } catch {
      setError('Could not add comment — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment…"
        aria-label="Add a comment"
        disabled={submitting}
        className="border border-gray-300 rounded px-3 py-2 text-sm min-h-[80px] resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !trimmed}
        aria-busy={submitting}
        className="self-end text-sm bg-gray-900 text-white rounded px-3 py-2 font-medium hover:bg-gray-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
      >
        {submitting ? 'Adding…' : 'Add comment'}
      </button>
    </div>
  );
}
