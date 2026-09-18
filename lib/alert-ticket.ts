// The "one ticket, one page, auto-closes on recovery" alert mechanism, extracted so more than one
// monitor can share it. lib/maintainer-health.ts established the shape when the nightly workers
// went dark for three weeks (2026-08-13 → 2026-09-11) with a perfectly accurate status file that
// nobody ever polled; lib/deploy-drift.ts reuses it for the 2026-09-18 deploy-drift incident, where
// production sat five days behind main and the only evidence was a container image tag.
//
// The contract both monitors rely on:
//   - fileAlert() keys on a STABLE source_ref, so createTicket's existing dedup identity
//     (dedup_key = source_ref + ticket_type) resolves every repeat onto the SAME ticket. The first
//     failure creates a ticket and pages Robin over Telegram; the fiftieth bumps event_count and
//     says nothing (lib/notify's sendTelegramNotify fires on ticket CREATE only).
//   - clearAlert() closes that ticket once the condition recovers, with a tuttle comment recording
//     why. Recovery is "the next run was clean", never a manual dismissal.
//
// NEITHER function catches. Each caller keeps its own try/catch and its own log label, so a
// ticket-filing fault is attributed to the monitor that hit it and can never take down the nightly
// cron it rides on. Callers must not let these throw into the cron body.

import { createTicket, findOpenTicketBySourceRef, patchTicket } from './tickets';
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

/** File (or dedup onto) the alert ticket for this condition. Throws on a DB fault. */
export function fileAlert(spec: AlertSpec): void {
  createTicket({
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
}

/**
 * Close a previously-filed alert for this condition, if one is still open. A no-op when the
 * condition never fired. Throws on a DB fault.
 */
export function clearAlert(sourceRef: string, resolutionNote: string): void {
  const existing = findOpenTicketBySourceRef(sourceRef, ALERT_TICKET_TYPE);
  if (!existing) return;
  patchTicket(existing.id, { status: 'done' });
  patchTicket(existing.id, {
    add_comment: { author: 'tuttle', body: resolutionNote },
  });
}
