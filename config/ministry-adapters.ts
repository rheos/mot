// mot/config/ministry-adapters.ts
//
// The machine-validated adapter config. Closed-set facts (ministries, ticket types,
// classifierInput modes) live here; vendor-specific routing detail lives in
// mot/skills/mot-intake/references/triage-rules.md.
// SYNC NOTE: keep this file in sync with triage-rules.md — when you add or rename a
// sourceId, ticketType, or classifierInput here, update the ownership boundary note
// there too (R-P2-4). Both files must reference each other explicitly.

import type { Ministry, Severity } from '../lib/enums';

export type MinistrySourceAdapter = {
  sourceId: string;
  ministry: Ministry;
  channel: 'gmail-poll' | 'webhook' | 'api-poll' | 'status-poll' | 'manual';
  cadence: 'high' | 'daily';
  sourceRefRule: 'gmail-message-id' | 'gmail-thread-id';
  defaultSeverity: Severity;
  ticketTypes: string[];
  classifierInput: 'minimal' | 'metadata-only';
  expectedFrequency?: { window: string; min: number };
};

export const MINISTRY_ADAPTERS: MinistrySourceAdapter[] = [
  {
    sourceId: 'gmail.intake',
    ministry: 'works',
    // ministry: 'works' — the adapter's home ministry for adapter-scoped tickets (e.g.
    // silent-feed). Per-email routing to commerce, education, etc. is the classifier's job;
    // this field is the adapter's own ministry, not the ticket destination. 'works' is the
    // neutral admin default and is non-sensitive, so classifierInput: 'minimal' is valid here.
    channel: 'gmail-poll',
    cadence: 'daily',
    sourceRefRule: 'gmail-thread-id',
    defaultSeverity: 'normal',
    ticketTypes: [
      'bill-due', 'statement-ready', 'renewal-notice', 'school-comm',
      'support-ticket', 'app-error', 'deploy-failure', 'payment-alert',
      'security-alert', 'account-alert', 'inquiry',
    ],
    classifierInput: 'minimal',
    // expectedFrequency intentionally omitted during the calibration period (R-P2-3):
    // the first adapter runs without a baseline for ~14 days before Taylor sets one.
    // Silent-feed detection is built and tested (EC-2) but the production trigger waits.
  },
];
