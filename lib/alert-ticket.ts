// The "one ticket, one page, auto-closes on recovery" alert mechanism, extracted so more than one
// monitor can share it. lib/maintainer-health.ts established the shape when the nightly workers
// went dark for three weeks (2026-08-13 → 2026-09-11) with a perfectly accurate status file that
// nobody ever polled; lib/deploy-drift.ts reuses it for the 2026-09-18 deploy-drift incident, where
// production sat five days behind main and the only evidence was a container image tag.
//
// The contract both monitors rely on:
//   - fileAlert() keys on a STABLE source_ref, so createTicket's existing dedup identity
//     (dedup_key = source_ref + ticket_type) resolves every repeat onto the SAME ticket. The first
//     failure creates a ticket AND pages Robin; the fiftieth bumps event_count and says nothing.
//
//     The page is sent from HERE, and that is the whole point of this module owning it. The
//     Telegram push used to live only in app/api/tickets/route.ts, so an in-process monitor calling
//     createTicket() filed a critical ticket and told nobody — maintainer-health never paged once
//     between #5 and #39, while viralvision's disk guardrail did, purely because it POSTs over
//     HTTP. An alarm that believes it pages and doesn't is worse than no alarm, so delivery now
//     hangs off the act of filing rather than off one transport that happens to reach it.
//   - clearAlert() closes that ticket once the condition recovers, with a tuttle comment recording
//     why. Recovery is "the next run was clean", never a manual dismissal.
//
// NEITHER function catches. Each caller keeps its own try/catch and its own log label, so a
// ticket-filing fault is attributed to the monitor that hit it and can never take down the nightly
// cron it rides on. Callers must not let these throw into the cron body.

import { createTicket, findOpenTicketBySourceRef, patchTicket } from './tickets';
import { sendTelegramNotify } from './notify';
import type { Severity } from './enums';

// Every alert this module files is an infra-alert, which is what makes the dedup identity
// (source_ref + ticket_type) collapse to "source_ref" in practice.
export const ALERT_TICKET_TYPE = 'infra-alert';

export interface AlertSpec {
  /** Stable across every repeat of the same condition — this IS the dedup identity. */
  sourceRef: string;
  title: string;
  body: string;
  severity: Severity;
}

/**
 * File (or dedup onto) the alert ticket for this condition, and page on a NEW incident.
 * Throws on a DB fault; a Telegram failure is swallowed (see below).
 */
export function fileAlert(spec: AlertSpec): void {
  const result = createTicket({
    title: spec.title,
    ministry: 'works',
    ticket_type: ALERT_TICKET_TYPE,
    severity: spec.severity,
    provenance: 'status-poll',
    source_ref: spec.sourceRef,
    body: spec.body,
    private: false,
    needs_review: false,
    event_count: 1,
  });

  // Page on 'created' (first occurrence) and on 'reopened' (the condition came back after it
  // resolved — a new incident, worth waking up for). NOT on 'updated' or 'grouped': those are the
  // fifth consecutive night of a fault already reported, which is what event_count is for. This is
  // the exactly-one-page-per-incident property the stable source_ref exists to provide.
  //
  // No severity gate, unlike the HTTP route. That route is a general-purpose endpoint and screens
  // for `critical` to keep arbitrary callers from paging; everything reaching fileAlert is a
  // monitor reporting a fault, there is a handful of them, and the dedup key already bounds the
  // volume. Severity drives triage ordering here, not delivery.
  if (result.action !== 'created' && result.action !== 'reopened') return;

  const t = result.ticket;
  const base = (process.env.MOT_BASE_URL ?? 'https://rheo.ca/mot').replace(/\/+$/, '');
  const text =
    `[${spec.severity.toUpperCase()}] ${spec.title}\n\n${spec.body}\n\n` +
    `${t.ministry} · ${t.ticket_type}\n${base}/tickets/${result.id}`;

  // Fire-and-forget, mirroring the route handler: a Telegram outage must never fail the alarm,
  // and must never throw into the nightly cron this runs inside. MOT is a long-lived container,
  // so the floating promise completes after the caller returns.
  void sendTelegramNotify(text).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[MOT/alert-ticket] page failed for ${spec.sourceRef}:`, err);
  });
}

/**
 * Close a previously-filed alert for this condition, if one is still open. A no-op when the
 * condition never fired. Throws on a DB fault.
 */
export function clearAlert(sourceRef: string, resolutionNote: string): void {
  const existing = findOpenTicketBySourceRef(sourceRef, ALERT_TICKET_TYPE);
  if (!existing) return;
  // One call, not two: patchTicket applies the status change and the comment inside a single
  // transaction, so the ticket can never end up closed with no record of why. (maintainer-health
  // used two sequential calls; a crash between them left exactly that.)
  patchTicket(existing.id, {
    status: 'done',
    add_comment: { author: 'tuttle', body: resolutionNote },
  });
}
