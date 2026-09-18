// Nightly maintainer failure monitoring. The resolution/dedup/profile workers went silently dark
// for three weeks (2026-08-13 → 2026-09-11): every worker wrote `ok:false` to maintainer-status.json
// every single night, but nothing ever surfaced that to Robin — `maintainer_status` is pull-only,
// and a status file nobody polls is the same as no status file. A memory system that stops recording
// without telling anyone is worse than one that is obviously down.
//
// This module is the push side: after each worker runs in the nightly cron (lib/backup.ts),
// reportWorkerHealth() files/updates a `critical` M.O.T. ticket when the worker came back
// `ok:false`, and closes that ticket automatically once the worker recovers. The file/close
// mechanics — one stable source_ref, one Telegram page, auto-close on recovery — now live in
// lib/alert-ticket.ts so lib/deploy-drift.ts can share them; the contract is unchanged.
//
// Never throws: a ticket-filing failure must not take down the nightly cron. Every call site wraps
// this in the same try/catch pattern already used for the workers themselves.

import { fileAlert, clearAlert } from './alert-ticket';

export type MaintainerWorkerName = 'resolution' | 'dedup' | 'autoconfirm' | 'profile';

// The minimal shape every worker status object satisfies (ResolutionStatus/DedupStatus/
// AutoconfirmStatus/ProfileStatus all have these fields — see lib/maintainer.ts / lib/profile.ts).
export interface WorkerHealthStatus {
  ok: boolean;
  error: string | null;
  batches_failed?: number;
}

// One stable ticket per worker — never changes across runs, so createTicket always resolves to the
// SAME dedup_key (source_ref + ticket_type) whether this is the first failure or the fiftieth.
function sourceRefFor(worker: MaintainerWorkerName): string {
  return `maintainer:${worker}`;
}

export function reportWorkerHealth(worker: MaintainerWorkerName, status: WorkerHealthStatus): void {
  try {
    const sourceRef = sourceRefFor(worker);

    if (!status.ok) {
      const batches =
        typeof status.batches_failed === 'number' ? ` (${status.batches_failed} batches failed)` : '';
      fileAlert({
        sourceRef,
        severity: 'critical',
        title: `Maintainer worker "${worker}" is failing`,
        body: `The nightly ${worker} maintainer worker reported ok:false${batches}.\n\nError: ${status.error ?? '(none captured)'}\n\nCheck \`maintainer_status\` for the current run; see MOT's CLAUDE.local.md § Recallatron ops (maintainer) for the LLM provider seam (MAINTAINER_LLM_PROVIDER) this worker depends on.`,
      });
      return;
    }

    // Recovered (or was already healthy). If a prior failure left an open alert ticket for this
    // worker, close it — the correction is "the next run succeeded", not a manual dismissal.
    clearAlert(sourceRef, `Resolved — the ${worker} worker reported ok:true on the next run.`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[MOT/maintainer-health] failed to report ${worker} health:`, e);
  }
}
