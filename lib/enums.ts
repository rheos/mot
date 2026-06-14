// Closed const enums. We use `as const` objects + string-literal union types rather than
// the TypeScript `enum` keyword (which does not tree-shake cleanly and emits runtime code).

export const Ministry = {
  works: 'works',
  commerce: 'commerce',
  plenty: 'plenty',
  peace: 'peace',
  education: 'education',
  flow: 'flow',
  interior: 'interior',
  foreign_affairs: 'foreign_affairs',
} as const;
export type Ministry = (typeof Ministry)[keyof typeof Ministry];

export const Status = {
  open: 'open',
  watching: 'watching',
  snoozed: 'snoozed',
  done: 'done',
  archived: 'archived',
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Severity = {
  critical: 'critical',
  high: 'high',
  normal: 'normal',
  low: 'low',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const Provenance = {
  'sentry-alert': 'sentry-alert',
  'stripe-webhook': 'stripe-webhook',
  'gmail-parse': 'gmail-parse',
  'status-poll': 'status-poll',
  manual: 'manual',
  heartbeat: 'heartbeat',
} as const;
export type Provenance = (typeof Provenance)[keyof typeof Provenance];

export const Author = {
  robin: 'robin',
  tuttle: 'tuttle',
} as const;
export type Author = (typeof Author)[keyof typeof Author];
