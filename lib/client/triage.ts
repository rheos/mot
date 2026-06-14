'use client';

// Shared client-side PATCH helper for the triage status controls (Watch / Snooze / Done) and
// the detail-view controls (Prompt 12). The triage list rows (Prompt 11) and the detail page
// both mutate a ticket the same way: a single PATCH /api/tickets/:id with the session cookie
// (sent automatically), then a server re-render to reflect the new state. Extracted here so the
// detail controls don't duplicate the row's fetch logic.
//
// Returns true on a 2xx response, false otherwise — the caller owns the busy/error UI and the
// router.refresh() that re-runs the Server Component query.
import { apiPath } from './base-path';

export async function patchTicketClient(
  ticketId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(apiPath(`/api/tickets/${ticketId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
