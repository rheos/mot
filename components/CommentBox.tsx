'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPath } from '../lib/client/base-path';

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
      const res = await fetch(apiPath(`/api/tickets/${ticketId}`), {
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
    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a note…"
        aria-label="Add a comment"
        disabled={submitting}
        rows={1}
        className="min-h-[42px] flex-1 resize-none rounded-[10px] border border-border bg-bg-alt px-3 py-2.5 text-sm text-ink focus:outline-none focus-visible:border-gold-line focus-visible:ring-2 focus-visible:ring-gold-glow disabled:opacity-50"
      />
      {error && <p className="text-xs text-amber sm:hidden">{error}</p>}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !trimmed}
        aria-busy={submitting}
        className="self-end rounded-ministry-sm border border-gold bg-gold px-4 py-2.5 text-sm font-bold text-on-gold transition hover:bg-gold-bright disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        {submitting ? 'Posting…' : 'Post'}
      </button>
      {error && <p className="hidden text-xs text-amber sm:block">{error}</p>}
    </div>
  );
}
